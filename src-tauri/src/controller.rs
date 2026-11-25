//! Owns the buds' state. One thread reacts to Windows events and opens or closes the link.

use crate::bt::link::{Event, Link, LinkError};
use crate::bt::protocol::*;
use crate::bt::watcher::{self, Presence, Wake};
use crate::windows_ui;
use serde::Serialize;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Reconnecting this soon after a drop doesn't show the popup again.
const QUIET_AFTER_DROP: Duration = Duration::from_secs(120);
/// Attempts per connection, so a busy pair is never hammered.
const MAX_OPENS: u32 = 3;
const RETRY: Duration = Duration::from_secs(2);
/// A link that lasted this long was healthy, so its loss doesn't count towards `MAX_OPENS`.
const HEALTHY: Duration = Duration::from_secs(10);
/// Windows drops and restores audio while buds move. Don't show a loss shorter than this.
const GRACE: Duration = Duration::from_millis(2500);
/// After this many tries a missing bud is taken to be switched off or far away.
const MAX_ASKS: u32 = 8;
/// How long to wait before asking again for a level the buds left out.
const ASK_AGAIN: Duration = Duration::from_millis(1500);
/// Turning off this soon after a change is worth explaining.
const EXPLAIN: Duration = Duration::from_secs(60);
/// The buds announce a new mode about 0.6 s after accepting it.
const MODE_CONFIRM: Duration = Duration::from_millis(1800);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    BluetoothOff,
    NotPaired,
    Unsupported,
    #[default]
    Disconnected,
    Connecting,
    Connected,
    /// Windows is using the buds but they don't answer us.
    Silent,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Buds {
    pub status: Status,
    pub name: Option<String>,
    pub battery: Battery,
    pub in_case: InCase,
    pub case_open: bool,
    pub mode: Option<Mode>,
    pub ear_detection: Option<bool>,
    pub one_bud: Option<bool>,
    pub left_press: Option<Press>,
    pub right_press: Option<Press>,
    pub color: Option<u8>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum Change {
    Mode(Mode),
    EarDetection(bool),
    OneBud(bool),
    Press(Side, Press),
    Name(String),
}

const NOT_IN_EAR: &str =
    "Your buds turned it off because they don't sense your ears. Reseat or clean them.";

pub struct Controller {
    app: AppHandle,
    buds: Mutex<Buds>,
    link: Mutex<Option<(u64, Arc<Link>, Instant)>>,
    low: Mutex<LowBattery>,
    /// The mode being confirmed. Reports of the old one are ignored meanwhile.
    wanted: Mutex<Option<Mode>>,
    /// The last mode the buds announced, and when we last changed it.
    announced: Mutex<Option<Mode>>,
    changed: Mutex<Option<Instant>>,
    wake: Sender<Wake>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Controller {
    pub fn start(app: &AppHandle) -> Arc<Self> {
        let (wake, woken) = channel();
        let c = Arc::new(Self {
            app: app.clone(),
            buds: Mutex::default(),
            link: Mutex::default(),
            low: Mutex::default(),
            wanted: Mutex::default(),
            announced: Mutex::default(),
            changed: Mutex::default(),
            wake,
        });
        let me = c.clone();
        std::thread::spawn(move || me.run(&woken));
        c
    }

    pub fn snapshot(&self) -> Buds {
        lock(&self.buds).clone()
    }

    fn update(&self, f: impl FnOnce(&mut Buds)) {
        let mut guard = lock(&self.buds);
        let before = guard.clone();
        f(&mut guard);
        let after = guard.clone();
        drop(guard);
        if after == before {
            return;
        }
        let _ = self.app.emit("buds", &after);
        crate::tray::refresh(&self.app, &after);
        if after.battery != before.battery
            && let Some(level) = lock(&self.low).check(&after.battery)
        {
            windows_ui::low_battery(&self.app, level);
        }
    }

    fn link(&self) -> Option<Arc<Link>> {
        lock(&self.link).as_ref().map(|(_, l, _)| l.clone())
    }

    fn drop_link(&self) {
        if let Some((_, l, _)) = lock(&self.link).take() {
            l.close();
        }
    }

    /// Reads everything, then shows it as one change. A setting the buds won't report is left as it was.
    fn read_all(&self, l: &Link) -> Result<(), LinkError> {
        fn known<T>(r: Result<T, LinkError>) -> Result<Option<T>, LinkError> {
            match r {
                Ok(v) => Ok(Some(v)),
                Err(LinkError::Lost) => Err(LinkError::Lost),
                Err(_) => Ok(None),
            }
        }
        let now = known(l.charge())?;
        let places = known(l.places())?;
        // The primary bud answers "off" whenever it isn't in an ear, so that isn't knowledge.
        let mode = known(l.mode())?
            .filter(|m| *m != Mode::Off || places.is_none_or(|p| p[0] != Place::Out));
        let name = known(l.name())?;
        let ear = known(l.ear_detection())?;
        let one_bud = known(l.one_bud())?;
        let buttons = known(l.buttons())?;
        let color = known(l.color())?;
        if now.is_some_and(|r| r.battery.incomplete()) {
            let _ = self.wake.send(Wake::Incomplete);
        }
        self.update(|b| {
            b.status = Status::Connected;
            if let Some(r) = now {
                charge(b, r);
            }
            b.mode = mode.or(b.mode);
            b.name = name.or(b.name.take());
            b.ear_detection = ear.or(b.ear_detection);
            b.one_bud = one_bud.or(b.one_bud);
            b.color = color.or(b.color);
            if let Some(v) = buttons {
                set_presses(b, v);
            }
        });
        Ok(())
    }

    /// True while a bud's level is still missing.
    fn ask_again(&self) -> bool {
        let Some(Ok(r)) = self.link().map(|l| l.charge()) else {
            return false;
        };
        self.update(|b| charge(b, r));
        r.battery.incomplete()
    }

    /// Sets the mode and waits for the buds to announce it.
    fn confirm_mode(&self, l: &Link, m: Mode, before: Option<Mode>) -> Result<(), LinkError> {
        *lock(&self.announced) = None;
        l.set_mode(m)?;
        *lock(&self.changed) = Some(Instant::now());
        if before == Some(m) {
            return Ok(()); // nothing changes, so nothing is announced
        }
        let until = Instant::now() + MODE_CONFIRM;
        while *lock(&self.announced) != Some(m) {
            if *lock(&self.wanted) != Some(m) {
                return Ok(()); // replaced by a newer choice
            }
            if Instant::now() > until {
                return Err(LinkError::Ignored);
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        Ok(())
    }

    /// Applies a change, then reads back what the buds really have.
    pub fn apply(&self, change: Change) -> Result<(), LinkError> {
        let l = self.link().ok_or(LinkError::Lost)?;
        match change {
            Change::Mode(m) => {
                let before = self.snapshot().mode;
                *lock(&self.wanted) = Some(m);
                self.update(|b| b.mode = Some(m));
                let done = self.confirm_mode(&l, m, before);
                // A newer choice may have replaced this one; leave that alone.
                let mut wanted = lock(&self.wanted);
                if *wanted == Some(m) {
                    *wanted = None;
                    drop(wanted);
                    if done.is_err() {
                        self.update(|b| b.mode = before);
                    }
                }
                done?;
            }
            Change::EarDetection(on) => {
                l.set_ear_detection(on)?;
                let v = l.ear_detection()?;
                self.update(|b| b.ear_detection = Some(v));
            }
            Change::OneBud(on) => {
                l.set_one_bud(on)?;
                let v = l.one_bud()?;
                self.update(|b| b.one_bud = Some(v));
            }
            Change::Press(side, press) => {
                l.set_press(side, press)?;
                let v = l.buttons()?;
                self.update(|b| set_presses(b, v));
            }
            Change::Name(n) => {
                l.set_name(&n)?;
                let v = l.name()?;
                self.update(|b| b.name = Some(v));
            }
        }
        Ok(())
    }

    fn on_event(&self, e: Event) {
        match e {
            Event::Notify(op::MODE_NOTIFY, p) => {
                let Some(m) = parse_mode(&p) else { return };
                *lock(&self.announced) = Some(m);
                // While a change is under way, announcements of other modes are out of date.
                let wanted = *lock(&self.wanted);
                if wanted.is_some_and(|w| w != m) {
                    return;
                }
                let was = self.snapshot().mode;
                self.update(|b| b.mode = Some(m));
                let recent = lock(&self.changed).is_some_and(|t| t.elapsed() < EXPLAIN);
                if wanted.is_none() && m == Mode::Off && was != Some(Mode::Off) && recent {
                    let _ = self.wake.send(Wake::SwitchedOff);
                }
            }
            Event::Notify(op::BATTERY_NOTIFY, p) => {
                let mut r = parse_report(&p);
                // Believe a swap of sides only if the buds say it again when asked.
                let doubt = r.seats.is_some_and(|s| s.swaps(lock(&self.buds).in_case));
                if doubt {
                    r.seats = None;
                }
                self.update(|b| charge(b, r));
                if doubt || r.battery.incomplete() {
                    let _ = self.wake.send(Wake::Incomplete);
                }
            }
            Event::Notify(..) => {}
            Event::Closed => {
                let _ = self.wake.send(Wake::Closed);
            }
        }
    }

    fn run(self: &Arc<Self>, woken: &Receiver<Wake>) {
        let _watchers = watcher::watch(&self.wake);
        let (mut was_connected, mut dropped, mut first) = (false, None::<Instant>, true);
        let mut lost = None::<Instant>;
        let (mut opens, mut asking) = (0, MAX_ASKS);
        let mut wait = Duration::ZERO;
        loop {
            match woken.recv_timeout(wait) {
                Ok(Wake::SwitchedOff) => {
                    *lock(&self.changed) = None; // explain once per change
                    let seated = lock(&self.buds).in_case;
                    let out = self
                        .link()
                        .and_then(|l| l.places().ok())
                        .is_some_and(|p| !p.contains(&Place::InEar));
                    if out && !(seated.left && seated.right) {
                        let _ = self.app.emit("notice", NOT_IN_EAR);
                    }
                    continue;
                }
                Ok(Wake::Incomplete) => {
                    wait = ASK_AGAIN;
                    asking = 0;
                    continue;
                }
                Ok(Wake::Closed) | Err(RecvTimeoutError::Timeout) => {}
                // Windows reports one change as a burst of events; let it settle briefly.
                Ok(Wake::Windows) => {
                    std::thread::sleep(Duration::from_millis(80));
                    while woken.try_recv().is_ok() {}
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
            wait = Duration::from_secs(30); // safety net if Windows misses an event

            let status = match watcher::presence() {
                Presence::Connected(address) => {
                    lost = None;
                    if !was_connected {
                        was_connected = true;
                        opens = 0;
                        self.update(|b| b.status = Status::Connecting);
                        if !first && dropped.is_none_or(|t| t.elapsed() > QUIET_AFTER_DROP) {
                            windows_ui::connected(&self.app);
                        }
                    }
                    first = false;
                    if !self.ensure_link(address, &mut opens) {
                        if opens < MAX_OPENS {
                            wait = RETRY; // presence is checked again before the next attempt
                        }
                    } else if asking < MAX_ASKS && self.ask_again() {
                        asking += 1;
                        wait = ASK_AGAIN;
                    }
                    continue;
                }
                Presence::BluetoothOff => Status::BluetoothOff,
                Presence::NotPaired => Status::NotPaired,
                Presence::Unsupported => Status::Unsupported,
                Presence::Disconnected => Status::Disconnected,
            };
            first = false;
            self.drop_link();
            opens = 0;
            if was_connected && status == Status::Disconnected {
                let since = lost.get_or_insert_with(Instant::now).elapsed();
                if since < GRACE {
                    wait = GRACE - since;
                    continue; // nothing on screen changes yet
                }
            }
            lost = None;
            if std::mem::take(&mut was_connected) {
                dropped = Some(Instant::now());
            }
            self.update(|b| {
                if status == Status::Disconnected {
                    b.status = status;
                    b.in_case = InCase::default();
                    b.battery = Battery::default().after(b.battery, b.in_case);
                } else {
                    *b = Buds {
                        status,
                        ..Buds::default()
                    };
                }
            });
        }
    }

    fn ensure_link(self: &Arc<Self>, address: u64, opens: &mut u32) -> bool {
        if let Some((a, l, since)) = &*lock(&self.link) {
            if *a == address && l.is_open() {
                return true;
            }
            if since.elapsed() > HEALTHY {
                *opens = 0;
            }
        }
        self.drop_link();
        if *opens >= MAX_OPENS {
            self.update(|b| b.status = Status::Silent);
            return false;
        }
        *opens += 1;
        let me = Arc::downgrade(self);
        let opened = Link::open(address, move |e| {
            if let Some(c) = me.upgrade() {
                c.on_event(e);
            }
        });
        // A failed attempt shows nothing: the next one is seconds away, and giving up is shown above.
        opened.is_ok_and(|l| {
            let l = Arc::new(l);
            let read = self.read_all(&l).is_ok();
            if read {
                *lock(&self.link) = Some((address, l, Instant::now()));
            }
            read
        })
    }
}

fn charge(b: &mut Buds, r: Report) {
    b.in_case = r.seats.unwrap_or(b.in_case);
    b.case_open = r.case_open.unwrap_or(b.case_open);
    b.battery = r.battery.after(b.battery, b.in_case);
    if !b.case_open
        && let Some(c) = &mut b.battery.case
    {
        c.stale = true; // a shut case can't report; this is its level from before
    }
}

fn set_presses(b: &mut Buds, v: [u8; 4]) {
    b.right_press = Press::from_byte(v[0]);
    b.left_press = Press::from_byte(v[1]);
}

/// Warns once at each threshold, and again only after the level has risen well clear of it.
#[derive(Default)]
struct LowBattery {
    warned: Option<u8>,
}

impl LowBattery {
    fn check(&mut self, b: &Battery) -> Option<u8> {
        let low = [b.left, b.right]
            .into_iter()
            .flatten()
            .filter(|c| !c.charging && !c.stale)
            .map(|c| c.percent)
            .min()?;
        let due = match low {
            0..=10 => Some(10),
            11..=20 => Some(20),
            _ => None,
        };
        if let Some(w) = self.warned
            && low >= w + 10
        {
            self.warned = due;
        }
        match (due, self.warned) {
            (Some(d), None) => self.warned = Some(d),
            (Some(d), Some(w)) if d < w => self.warned = Some(d),
            _ => return None,
        }
        Some(low)
    }
}

pub fn get(app: &AppHandle) -> Arc<Controller> {
    app.state::<Arc<Controller>>().inner().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(left: u8, right: u8) -> Battery {
        let c = |percent| {
            Some(Cell {
                percent,
                charging: false,
                stale: false,
            })
        };
        Battery {
            left: c(left),
            right: c(right),
            case: None,
        }
    }

    #[test]
    fn low_battery_warns_once_per_threshold() {
        let mut l = LowBattery::default();
        assert_eq!(l.check(&at(80, 21)), None);
        assert_eq!(l.check(&at(80, 20)), Some(20));
        assert_eq!(l.check(&at(80, 19)), None);
        assert_eq!(l.check(&at(80, 21)), None); // jitter doesn't re-arm
        assert_eq!(l.check(&at(80, 20)), None);
        assert_eq!(l.check(&at(80, 10)), Some(10));
        assert_eq!(l.check(&at(80, 9)), None);
        assert_eq!(l.check(&at(80, 60)), None); // charged: re-armed
        assert_eq!(l.check(&at(80, 18)), Some(18));
    }

    #[test]
    fn charging_buds_do_not_warn() {
        let c = Some(Cell {
            percent: 5,
            charging: true,
            stale: false,
        });
        assert_eq!(
            LowBattery::default().check(&Battery {
                left: c,
                right: c,
                case: None
            }),
            None
        );
    }
}
