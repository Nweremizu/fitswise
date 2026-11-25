//! One RFCOMM connection to the buds, plus typed requests.
//!
//! Callers must only open a link while Windows already has the buds connected for audio
//! (see `watcher`), because opening it would otherwise pull the buds away from a phone.

use super::protocol::*;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::windows::io::FromRawSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Devices::Bluetooth::{AF_BTH, BTHPROTO_RFCOMM, SOCKADDR_BTH};
use windows::Win32::Networking::WinSock::{
    SOCK_STREAM, SOCKADDR, WSA_FLAG_OVERLAPPED, WSADATA, WSASocketW, WSAStartup, closesocket,
    connect,
};

const CHANNEL: u32 = 1;
const REPLY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkError {
    /// The connection is gone; a new link is needed.
    Lost,
    /// The buds answered with a failure status, or with something unreadable.
    Refused,
    /// The buds said yes but never announced the new mode.
    Ignored,
    NoAnswer,
    Invalid(&'static str),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Lost => "The connection to the buds was lost.",
            Self::Refused => "The buds refused the change.",
            Self::Ignored => "The buds didn't switch. Put them in and try again.",
            Self::NoAnswer => "The buds didn't answer.",
            Self::Invalid(m) => m,
        })
    }
}

type Result<T> = std::result::Result<T, LinkError>;

pub enum Event {
    Notify(u16, Vec<u8>),
    Closed,
}

pub struct Link {
    // RFCOMM is a stream socket, so std's TcpStream gives read, write and shutdown for free.
    sock: TcpStream,
    send: Arc<Mutex<TcpStream>>,
    request: Mutex<(u8, Receiver<Frame>)>,
    open: Arc<AtomicBool>,
}

fn connect_rfcomm(address: u64) -> Option<TcpStream> {
    unsafe {
        let mut data = WSADATA::default();
        if WSAStartup(0x0202, &mut data) != 0 {
            return None;
        }
        let s = WSASocketW(
            i32::from(AF_BTH),
            SOCK_STREAM.0,
            BTHPROTO_RFCOMM as i32,
            None,
            0,
            WSA_FLAG_OVERLAPPED,
        )
        .ok()?;
        let to = SOCKADDR_BTH {
            addressFamily: AF_BTH,
            btAddr: address,
            port: CHANNEL,
            ..Default::default()
        };
        if connect(
            s,
            (&raw const to).cast::<SOCKADDR>(),
            size_of::<SOCKADDR_BTH>() as i32,
        ) != 0
        {
            closesocket(s);
            return None;
        }
        Some(TcpStream::from_raw_socket(s.0 as _))
    }
}

impl Link {
    pub fn open(address: u64, on_event: impl Fn(Event) + Send + 'static) -> Result<Self> {
        let sock = connect_rfcomm(address).ok_or(LinkError::Lost)?;
        let clone = || sock.try_clone().map_err(|_| LinkError::Lost);
        let (reader, send) = (clone()?, Arc::new(Mutex::new(clone()?)));
        let (tx, rx) = channel();
        let acks = send.clone();
        let open = Arc::new(AtomicBool::new(true));
        let alive = open.clone();
        std::thread::spawn(move || {
            read_loop(reader, &acks, &tx, &on_event);
            alive.store(false, Ordering::SeqCst);
            on_event(Event::Closed);
        });
        let link = Self {
            sock,
            send,
            request: Mutex::new((0, rx)),
            open,
        };
        link.ask(op::HELLO, &[0, 2], Some(HELLO_SEQ))?;
        Ok(link)
    }

    fn ask(&self, op: u16, payload: &[u8], seq: Option<u8>) -> Result<Vec<u8>> {
        let mut guard = self.request.lock().unwrap_or_else(|e| e.into_inner());
        let seq = seq.unwrap_or_else(|| {
            guard.0 = guard.0 % 0xfe + 1; // 1..=0xfe; 0xff is hello
            guard.0
        });
        let frame = encode(seq, op, payload);
        for _ in 0..2 {
            let mut s = self.send.lock().unwrap_or_else(|e| e.into_inner());
            s.write_all(&frame).map_err(|_| LinkError::Lost)?;
            drop(s);
            let until = Instant::now() + REPLY_TIMEOUT;
            loop {
                match guard
                    .1
                    .recv_timeout(until.saturating_duration_since(Instant::now()))
                {
                    Ok(f) if (f.seq, f.op) == (seq, op + 1) => {
                        return match f.payload.split_first() {
                            Some((0, rest)) => Ok(rest.to_vec()),
                            _ => Err(LinkError::Refused),
                        };
                    }
                    Ok(_) => {} // late reply to an earlier request
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return Err(LinkError::Lost),
                }
            }
        }
        Err(LinkError::NoAnswer)
    }

    fn get(&self, op: u16, payload: &[u8]) -> Result<Vec<u8>> {
        self.ask(op, payload, None)
    }

    fn byte(&self, op: u16, payload: &[u8]) -> Result<u8> {
        self.get(op, payload)?
            .first()
            .copied()
            .ok_or(LinkError::Refused)
    }

    /// Answers for the primary bud only, which says off while it isn't in an ear. Announcements
    /// (`MODE_NOTIFY`) are the truth; use this only to start from something.
    pub fn mode(&self) -> Result<Mode> {
        Ok(if self.byte(op::MODE_GET, &[1])? > 0 {
            Mode::Anc
        } else if self.byte(op::MODE_GET, &[2])? > 0 {
            Mode::Transparency
        } else {
            Mode::Off
        })
    }

    pub fn set_mode(&self, m: Mode) -> Result<()> {
        let done = self.get(op::MODE_SET, &[m as u8, 100]).map(drop);
        trace(&format!("set {m:?} {done:?}"), &[]);
        done
    }

    /// Battery levels and, from the same message, which buds are in the case.
    pub fn charge(&self) -> Result<Report> {
        let raw = self.get(op::BATTERY_GET, &[])?;
        trace("battery", &raw);
        Ok(parse_report(&raw))
    }

    pub fn name(&self) -> Result<String> {
        let raw = self.get(op::NAME_GET, &[])?;
        Ok(String::from_utf8_lossy(&raw)
            .trim_end_matches('\0')
            .to_string())
    }

    pub fn set_name(&self, name: &str) -> Result<()> {
        let raw =
            name_bytes(name).ok_or(LinkError::Invalid("Use 1 to 32 characters of plain text."))?;
        self.get(op::NAME_SET, raw).map(drop)
    }

    pub fn ear_detection(&self) -> Result<bool> {
        Ok(self.byte(op::EAR_GET, &[])? == 1)
    }

    pub fn set_ear_detection(&self, on: bool) -> Result<()> {
        self.get(op::EAR_SET, &[if on { 1 } else { 2 }]).map(drop)
    }

    pub fn one_bud(&self) -> Result<bool> {
        Ok(self.byte(op::ONE_BUD_GET, &[])? == 1)
    }

    pub fn set_one_bud(&self, on: bool) -> Result<()> {
        self.get(op::ONE_BUD_SET, &[u8::from(on)]).map(drop)
    }

    pub fn buttons(&self) -> Result<[u8; 4]> {
        let raw = self.get(op::BUTTONS_GET, &[])?;
        raw.get(..4)
            .and_then(|b| b.try_into().ok())
            .ok_or(LinkError::Refused)
    }

    pub fn set_press(&self, side: Side, press: Press) -> Result<()> {
        let next = choose_press(self.buttons()?, side, press);
        self.get(op::BUTTONS_SET, &next).map(drop)
    }

    /// Primary then secondary, from the buds' own sensors.
    pub fn places(&self) -> Result<[Place; 2]> {
        let raw = self.get(op::LOCATION_GET, &[])?;
        match raw.get(..2) {
            Some(&[a, b]) => Ok([Place::from_byte(a), Place::from_byte(b)]),
            _ => Err(LinkError::Refused),
        }
    }

    pub fn color(&self) -> Result<u8> {
        self.byte(op::COLOR_GET, &[])
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    pub fn close(&self) {
        let _ = self.sock.shutdown(Shutdown::Both);
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.close();
    }
}

fn read_loop(
    mut sock: TcpStream,
    acks: &Mutex<TcpStream>,
    replies: &Sender<Frame>,
    on_event: &dyn Fn(Event),
) {
    let (mut buf, mut chunk) = (Vec::new(), [0u8; 1024]);
    'link: while let Ok(n @ 1..) = sock.read(&mut chunk) {
        buf.extend(&chunk[..n]);
        for f in decode(&mut buf) {
            if f.op & 1 == 1 {
                let _ = replies.send(f);
                continue;
            }
            // The buds repeat a notification until it is acknowledged.
            let ack = encode(f.seq, f.op + 1, &[0]);
            if acks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .write_all(&ack)
                .is_err()
            {
                break 'link;
            }
            if matches!(f.op, op::BATTERY_NOTIFY | op::MODE_NOTIFY) {
                trace(&format!("{:04x}", f.op), &f.payload);
            }
            on_event(Event::Notify(f.op, f.payload));
        }
    }
}

/// Development builds keep what the buds report in `%TEMP%\\fitswise-trace.log`.
fn trace(what: &str, p: &[u8]) {
    if cfg!(debug_assertions) {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::temp_dir().join("fitswise-trace.log"));
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() % 86_400_000);
        if let Ok(mut f) = file {
            let (h, m, s) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60);
            let _ = writeln!(f, "{h:02}:{m:02}:{s:02}.{:03} {what} {p:02x?}", ms % 1000);
        }
    }
}
