//! Talks to the buds without the app: `cargo run --example cli -- [watch SECONDS | anc | transparency | off]`.
//! Like the app, it opens a link only while Windows is already using them for audio.

use fitswise_lib::bt::link::{Event, Link};
use fitswise_lib::bt::protocol::Mode;
use fitswise_lib::bt::watcher::{Presence, presence, watch};
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let t = Instant::now();
    let now = presence();
    println!("{now:?} ({} ms)", t.elapsed().as_millis());
    if args.first().is_some_and(|a| a == "watch") {
        return watch_only(args.get(1).and_then(|s| s.parse().ok()).unwrap_or(30));
    }
    let Presence::Connected(address) = now else {
        return;
    };
    let t = Instant::now();
    let link = match Link::open(address, |e| {
        if let Event::Notify(op, p) = e {
            println!("  notify {op:04x} {p:02x?}");
        }
    }) {
        Ok(l) => l,
        Err(e) => return println!("link: {e}"),
    };
    println!("link open ({} ms)", t.elapsed().as_millis());
    let mode = match args.first().map(String::as_str) {
        Some("anc") => Some(Mode::Anc),
        Some("transparency") => Some(Mode::Transparency),
        Some("off") => Some(Mode::Off),
        _ => None,
    };
    if let Some(m) = mode {
        let t = Instant::now();
        println!(
            "set {m:?}: {:?} ({} ms)",
            link.set_mode(m),
            t.elapsed().as_millis()
        );
    }
    if args.first().is_some_and(|a| a == "battery") {
        let seconds = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(60);
        let (end, mut last) = (Instant::now() + Duration::from_secs(seconds), String::new());
        while Instant::now() < end {
            let now = format!("{:?}", link.charge());
            if now != last {
                println!("{now}");
                last = now;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        return;
    }
    println!("name      {:?}", link.name());
    println!("battery   {:?}", link.charge());
    println!("mode      {:?}", link.mode());
    println!("ear       {:?}", link.ear_detection());
    println!("one bud   {:?}", link.one_bud());
    println!("buttons   {:?}", link.buttons());
    println!("colour    {:?}", link.color());
    println!("all read  {} ms", t.elapsed().as_millis());
}

/// Prints every change Windows reports, without opening a link.
fn watch_only(seconds: u64) {
    let (tx, rx) = std::sync::mpsc::channel();
    let _watchers = watch(&tx).expect("watchers");
    let end = Instant::now() + Duration::from_secs(seconds);
    let mut last = None;
    while Instant::now() < end {
        let _ = rx.recv_timeout(Duration::from_millis(500));
        let p = Some(presence());
        if p != last {
            println!("{:?}", p.as_ref().unwrap());
            last = p;
        }
    }
}
