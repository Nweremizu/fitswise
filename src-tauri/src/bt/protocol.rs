//! Apple "B2P" frames, as spoken over RFCOMM channel 1. No I/O here.
//!
//! `ff b2 | total length u16le | sequence | opcode u16le | payload | crc32 u32le`

use serde::{Deserialize, Serialize};

pub const HELLO_SEQ: u8 = 0xff;
const MARK: [u8; 2] = [0xff, 0xb2];
const OVERHEAD: usize = 11;
const MAX_FRAME: usize = 2048;

/// Every opcode this app may send. Never add flash, firmware, shipping or reset commands.
pub mod op {
    pub const HELLO: u16 = 0x4000;
    pub const COLOR_GET: u16 = 0x4116;
    pub const NAME_GET: u16 = 0x412c;
    pub const NAME_SET: u16 = 0x4134;
    pub const EAR_SET: u16 = 0x414a;
    pub const EAR_GET: u16 = 0x414c;
    pub const MODE_GET: u16 = 0x4158;
    pub const MODE_SET: u16 = 0x415a;
    pub const BATTERY_GET: u16 = 0x4430;
    pub const BUTTONS_SET: u16 = 0x4468;
    pub const BUTTONS_GET: u16 = 0x446a;
    /// Primary then secondary: 0 in ear, 1 out, 2 in case.
    pub const LOCATION_GET: u16 = 0x4478;
    pub const ONE_BUD_GET: u16 = 0x447c;
    pub const ONE_BUD_SET: u16 = 0x447e;
    /// Sent by the buds.
    pub const MODE_NOTIFY: u16 = 0x015e;
    pub const BATTERY_NOTIFY: u16 = 0x0434;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub seq: u8,
    pub op: u16,
    pub payload: Vec<u8>,
}

/// MSB-first CRC-32, poly 04c11db7, init 0, inverted output. Not the zlib CRC.
fn crc32(data: &[u8]) -> u32 {
    let mut c = 0u32;
    for b in data {
        c ^= u32::from(*b) << 24;
        for _ in 0..8 {
            c = if c >> 31 == 1 {
                (c << 1) ^ 0x04c1_1db7
            } else {
                c << 1
            };
        }
    }
    !c
}

pub fn encode(seq: u8, op: u16, payload: &[u8]) -> Vec<u8> {
    let total = OVERHEAD + payload.len();
    let mut f = Vec::with_capacity(total);
    f.extend(MARK);
    f.extend((total as u16).to_le_bytes());
    f.push(seq);
    f.extend(op.to_le_bytes());
    f.extend(payload);
    f.extend(crc32(&f).to_le_bytes());
    f
}

/// Removes and returns every complete valid frame, resynchronising past junk.
pub fn decode(buf: &mut Vec<u8>) -> Vec<Frame> {
    let mut out = Vec::new();
    loop {
        match buf.windows(2).position(|w| w == MARK) {
            Some(i) => drop(buf.drain(..i)),
            None => {
                let keep = usize::from(buf.last() == Some(&MARK[0]));
                buf.drain(..buf.len() - keep);
                return out;
            }
        }
        if buf.len() < 4 {
            return out;
        }
        let n = usize::from(u16::from_le_bytes([buf[2], buf[3]]));
        if !(OVERHEAD..=MAX_FRAME).contains(&n) {
            buf.drain(..2);
            continue;
        }
        if buf.len() < n {
            return out;
        }
        let crc = u32::from_le_bytes([buf[n - 4], buf[n - 3], buf[n - 2], buf[n - 1]]);
        if crc32(&buf[..n - 4]) != crc {
            buf.drain(..2);
            continue;
        }
        out.push(Frame {
            seq: buf[4],
            op: u16::from_le_bytes([buf[5], buf[6]]),
            payload: buf[7..n - 4].to_vec(),
        });
        buf.drain(..n);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Off = 0,
    Anc = 1,
    Transparency = 2,
}

/// `[kind, anc level, transparency level]`
pub fn parse_mode(p: &[u8]) -> Option<Mode> {
    let (anc, transparency) = (*p.get(1)?, *p.get(2)?);
    Some(if anc > 0 {
        Mode::Anc
    } else if transparency > 0 {
        Mode::Transparency
    } else {
        Mode::Off
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Cell {
    pub percent: u8,
    pub charging: bool,
    /// No longer reported, so this is the last known level.
    pub stale: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Battery {
    pub left: Option<Cell>,
    pub right: Option<Cell>,
    pub case: Option<Cell>,
}

/// Five bytes each: part, 1, percent, state (1 charging, 2 in use, 4 absent), 1.
/// The last group is not a battery (its second byte is 0) and may start with a part number.
pub fn parse_battery(p: &[u8]) -> Battery {
    let mut b = Battery::default();
    for e in p.chunks_exact(5) {
        if e[1] != 1 {
            continue;
        }
        // A part that is asleep or just waking reports 0 or a level above 100.
        let cell = (e[3] != 4 && (1..=100).contains(&e[2])).then_some(Cell {
            percent: e[2],
            charging: e[3] == 1,
            stale: false,
        });
        match e[0] {
            4 => b.left = cell,
            2 => b.right = cell,
            8 => b.case = cell,
            _ => {}
        }
    }
    b
}

impl Battery {
    /// A part can report "unknown" while buds move, and the buds don't always follow up. Keep its
    /// last level. In the case nothing has changed for it; outside, it is marked as old.
    pub fn after(self, old: Battery, seats: InCase) -> Battery {
        let keep = |new: Option<Cell>, old: Option<Cell>, seated: bool| {
            new.or(old.map(|c| Cell {
                charging: c.charging && seated,
                stale: c.stale || !seated,
                ..c
            }))
        };
        Battery {
            left: keep(self.left, old.left, seats.left),
            right: keep(self.right, old.right, seats.right),
            case: keep(self.case, old.case, seats.left || seats.right),
        }
    }

    /// A bud's level is missing, so it is worth asking again.
    pub fn incomplete(&self) -> bool {
        self.left.is_none() || self.right.is_none()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InCase {
    pub left: bool,
    pub right: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    InEar,
    Out,
    InCase,
    Unknown,
}

impl Place {
    pub fn from_byte(b: u8) -> Self {
        match b {
            0 => Self::InEar,
            1 => Self::Out,
            2 => Self::InCase,
            _ => Self::Unknown,
        }
    }
}

impl InCase {
    /// One bud going in at the very moment the other comes out. While the buds hand over, they
    /// report the sides the wrong way round for a few milliseconds.
    pub fn swaps(self, old: InCase) -> bool {
        self.left != self.right && self.left == old.right && self.right == old.left
    }
}

const IN_CASE: u8 = 2;

/// Everything one battery report says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    pub battery: Battery,
    pub seats: Option<InCase>,
    pub case_open: Option<bool>,
}

pub fn parse_report(p: &[u8]) -> Report {
    Report {
        battery: parse_battery(p),
        seats: parse_in_case(p),
        case_open: parse_case_open(p),
    }
}

/// The case reports itself absent while its lid is shut, and a level once it opens.
pub fn parse_case_open(p: &[u8]) -> Option<bool> {
    let e = p.chunks_exact(5).find(|e| e[0] == 8 && e[1] == 1)?;
    match e[3] {
        4 => Some(false),
        _ if (1..=100).contains(&e[2]) => Some(true),
        _ => None, // waking up
    }
}

/// The report's last group is `[lid, 0, ff, left, right]`. Its second byte tells it from a battery.
/// With the lid shut the case reports itself absent and both buds read "out", but a bud that is
/// charging can only be in the case. (With the lid open, a lifted bud still says "charging" briefly.)
pub fn parse_in_case(p: &[u8]) -> Option<InCase> {
    let last = p.chunks_exact(5).find(|e| e[1] == 0)?;
    let state = |part| {
        p.chunks_exact(5)
            .find(|e| e[0] == part && e[1] == 1)
            .map(|e| e[3])
    };
    let shut = parse_case_open(p) == Some(false);
    let charging = |part| shut && state(part) == Some(1);
    Some(InCase {
        left: last[3] == IN_CASE || charging(4),
        right: last[4] == IN_CASE || charging(2),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Press {
    Voice = 1,
    Noise = 5,
    VolumeUp = 6,
    VolumeDown = 7,
}

impl Press {
    pub fn from_byte(b: u8) -> Option<Self> {
        [Self::Voice, Self::Noise, Self::VolumeUp, Self::VolumeDown]
            .into_iter()
            .find(|p| *p as u8 == b)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Right = 0,
    Left = 1,
}

fn is_volume(b: u8) -> bool {
    b == Press::VolumeUp as u8 || b == Press::VolumeDown as u8
}

/// `[right, left, cached right, cached left]`. Volume is all or nothing: the other bud takes the
/// opposite direction, and leaving volume puts it back on its cached action.
pub fn choose_press(mut b: [u8; 4], side: Side, press: Press) -> [u8; 4] {
    let (s, other, v) = (side as usize, 1 - side as usize, press as u8);
    b[s] = v;
    if is_volume(v) {
        b[other] = Press::VolumeUp as u8 + Press::VolumeDown as u8 - v;
    } else {
        b[s + 2] = v;
        if is_volume(b[other]) {
            b[other] = b[other + 2];
        }
    }
    b
}

/// The limit is ours; the real one is unknown.
pub fn name_bytes(name: &str) -> Option<&[u8]> {
    let n = name.trim();
    (!n.is_empty() && n.len() <= 32 && !n.chars().any(char::is_control)).then_some(n.as_bytes())
}

#[cfg(test)]
mod tests {
    //! Frames recorded from the Android app talking to a real pair.
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn battery_frame() -> Vec<u8> {
        h("ffb2200017314400040162020102015f020108010004010000ff0101049e2745")
    }

    #[test]
    fn encodes_recorded_frames() {
        assert_eq!(
            encode(HELLO_SEQ, op::HELLO, &[0, 2]),
            h("ffb20d00ff00400002d9869c5a")
        );
        assert_eq!(
            encode(0x19, op::MODE_SET, &[1, 100]),
            h("ffb20d00195a41016456255ce6")
        );
        assert_eq!(encode(0x0f, op::EAR_GET, &[]), h("ffb20b000f4c41301f6891"));
    }

    #[test]
    fn decodes_split_frames_after_junk() {
        let f = battery_frame();
        let mut buf = [b"junk\xff".as_slice(), &f[..9]].concat();
        assert!(decode(&mut buf).is_empty());
        buf.extend(&f[9..]);
        let got = decode(&mut buf);
        assert_eq!((got.len(), got[0].seq, got[0].op), (1, 0x17, 0x4431));
        assert!(buf.is_empty());
        let b = parse_battery(&got[0].payload[1..]);
        assert_eq!(
            b.left,
            Some(Cell {
                percent: 98,
                charging: false,
                stale: false
            })
        );
        assert_eq!(
            b.right,
            Some(Cell {
                percent: 95,
                charging: false,
                stale: false
            })
        );
        assert_eq!(b.case, None);
    }

    #[test]
    fn rejects_corruption_and_recovers() {
        let mut bad = battery_frame();
        bad[10] ^= 1;
        bad.extend(battery_frame());
        assert_eq!(decode(&mut bad).len(), 1);
    }

    #[test]
    fn never_panics_on_noise() {
        let mut x = 12345u32;
        let mut buf = Vec::new();
        for _ in 0..20_000 {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            buf.push(match x >> 29 {
                0 => 0xff,
                1 => 0xb2,
                _ => (x >> 16) as u8,
            });
            decode(&mut buf);
        }
        parse_battery(&[4, 1, 200]);
        assert_eq!(parse_mode(&[2, 1]), None);
    }

    #[test]
    fn modes() {
        assert_eq!(parse_mode(&h("026400")), Some(Mode::Anc));
        assert_eq!(parse_mode(&h("020064")), Some(Mode::Transparency));
        assert_eq!(parse_mode(&h("020000")), Some(Mode::Off));
    }

    #[test]
    fn press_rules() {
        assert_eq!(
            choose_press([6, 7, 5, 5], Side::Left, Press::VolumeUp),
            [7, 6, 5, 5]
        ); // recorded
        assert_eq!(
            choose_press([7, 6, 5, 5], Side::Left, Press::VolumeDown),
            [6, 7, 5, 5]
        ); // recorded
        assert_eq!(
            choose_press([6, 7, 5, 5], Side::Left, Press::Voice),
            [5, 1, 5, 1]
        );
        assert_eq!(
            choose_press([5, 1, 5, 1], Side::Right, Press::Voice),
            [1, 1, 1, 1]
        );
    }

    #[test]
    fn right_bud_survives_the_trailer_in_the_case() {
        // recorded with both buds seated in the open case
        let b = parse_battery(&h("04015d0101020160010108016302010200ff0202"));
        assert_eq!(
            b.left,
            Some(Cell {
                percent: 93,
                charging: true,
                stale: false
            })
        );
        assert_eq!(
            b.right,
            Some(Cell {
                percent: 96,
                charging: true,
                stale: false
            })
        );
        assert_eq!(
            b.case,
            Some(Cell {
                percent: 99,
                charging: false,
                stale: false
            })
        );
    }

    #[test]
    fn unknown_parts_keep_what_was_true() {
        let seats = |left, right| InCase { left, right };
        let both = parse_battery(&h("04015d0101020160010108016302010200ff0202"));
        // Recorded: left put back, right reports "unknown" though it sits in the case charging.
        let gap = parse_battery(&h("04016401010201ff030108010003010200ff0202"));
        assert_eq!((gap.right, gap.case), (None, None));
        assert!(gap.incomplete() && !both.incomplete());
        let kept = gap.after(both, seats(true, true));
        assert!(
            kept.right
                .is_some_and(|c| c.percent == 96 && c.charging && !c.stale)
        );
        assert!(kept.case.is_some_and(|c| c.percent == 99 && !c.stale));
        // The same gap with the right bud out of the case.
        let out = gap.after(both, seats(true, false));
        assert!(
            out.right
                .is_some_and(|c| c.percent == 96 && !c.charging && c.stale)
        );
        // Everything gone, as after a disconnect.
        let gone = Battery::default().after(both, seats(false, false));
        assert!(
            [gone.left, gone.right, gone.case]
                .iter()
                .all(|c| c.is_some_and(|c| c.stale))
        );
        assert_eq!(both.after(gone, seats(true, true)), both);
    }

    /// Reports recorded while real buds were taken out and put back.
    #[test]
    fn follows_real_movements() {
        let steps = [
            ("0401630101020163010108016401010200ff0202", (true, true)), // both seated
            ("0401630101020163030108016401010200ff0201", (true, false)), // right lifted
            ("020162020104016401010801640101 0000ff0201", (true, false)), // right worn, now primary
            ("020162010104016401010801640101 0200ff0202", (true, true)), // right back
            ("020162010104016401010801640101 0200ff0102", (false, true)), // left lifted
            ("040164020102016201010801640101 0000ff0102", (false, true)), // left worn, now primary
            ("0401640101 0201ff0301 0801000301 0200ff0202", (true, true)), // right waking: unknown levels
            ("0401640101 0201ff0301 0801640101 0200ff0201", (true, false)), // right lifted
        ];
        let mut shown = Battery::default();
        for (hex, (left, right)) in steps {
            let p = h(&hex.replace(' ', ""));
            assert_eq!(parse_in_case(&p), Some(InCase { left, right }), "{hex}");
            shown = parse_battery(&p).after(shown, InCase { left, right });
            for c in [shown.left, shown.right, shown.case] {
                assert!(c.is_some_and(|c| c.percent >= 90), "{hex}: {shown:?}");
            }
        }
    }

    #[test]
    fn spots_the_handover_swap() {
        // Recorded 30 ms apart: left was lifted throughout.
        let lifted = parse_in_case(&h("0201610101040164010108016401010200ff0102")).unwrap();
        let swapped = parse_in_case(&h("0401640101020161010108016401010200ff0201")).unwrap();
        let after = parse_in_case(&h("0401640201020161010108016401010000ff0102")).unwrap();
        assert!(swapped.swaps(lifted) && after.swaps(swapped) && !after.swaps(lifted));
        let both = InCase {
            left: true,
            right: true,
        };
        assert!(!lifted.swaps(both) && !both.swaps(lifted) && !InCase::default().swaps(lifted));
    }

    #[test]
    fn a_bud_in_a_shut_case_is_in_the_case() {
        // Recorded: left worn, right charging in the case with the lid shut (case reports absent).
        let p = h("04016402010201610101080100040100 00ff0101"
            .replace(' ', "")
            .as_str());
        assert_eq!(
            parse_in_case(&p),
            Some(InCase {
                left: false,
                right: true
            })
        );
        let shown = parse_battery(&p).after(Battery::default(), parse_in_case(&p).unwrap());
        assert!(
            shown
                .right
                .is_some_and(|c| c.percent == 97 && c.charging && !c.stale)
        );
    }

    #[test]
    fn the_lid() {
        assert_eq!(
            parse_case_open(&h("04016402010201610101080100040100 00ff0101"
                .replace(' ', "")
                .as_str())),
            Some(false)
        );
        assert_eq!(
            parse_case_open(&h("0401630101020163010108016401010200ff0202")),
            Some(true)
        );
        assert_eq!(
            parse_case_open(&h("04016401010201ff030108010003010200ff0202")),
            None
        );
    }

    #[test]
    fn a_short_report_has_no_position() {
        assert_eq!(parse_in_case(&h("0401630101")), None);
        assert_eq!(parse_in_case(&[]), None);
    }

    #[test]
    fn names() {
        assert_eq!(name_bytes("  Test1 "), Some(b"Test1".as_slice()));
        assert!(name_bytes("   ").is_none());
        assert!(name_bytes("a\nb").is_none());
        assert!(name_bytes(&"é".repeat(17)).is_none());
    }
}
