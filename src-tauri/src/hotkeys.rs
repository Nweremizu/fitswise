//! Global shortcuts. A clash is always reported, never ignored.

use crate::bt::protocol::Mode;
use crate::controller::{self, Change};
use crate::settings::Shortcuts;
use serde::Serialize;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayoutList, HKL, ToUnicodeEx, VK_CONTROL, VK_MENU, VK_SHIFT,
};

/// Why a shortcut isn't active, per action. `None` means it is active or unset.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Problems {
    pub anc: Option<String>,
    pub transparency: Option<String>,
    pub off: Option<String>,
    pub open: Option<String>,
}

#[derive(Clone, Copy)]
enum Action {
    Set(Mode),
    Open,
}

#[derive(Default)]
pub struct Hotkeys {
    active: Mutex<Vec<(Shortcut, Action)>>,
    problems: Mutex<Problems>,
}

pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed {
                pressed(app, shortcut);
            }
        })
        .build()
}

fn pressed(app: &AppHandle, shortcut: &Shortcut) {
    let state = app.state::<Hotkeys>();
    let hit = state
        .active
        .lock()
        .unwrap()
        .iter()
        .find(|(s, _)| s == shortcut)
        .map(|(_, a)| *a);
    let app = app.clone();
    // Talking to the buds can take a moment, so never do it on the main thread.
    match hit {
        Some(Action::Set(m)) => drop(std::thread::spawn(move || {
            controller::get(&app).apply(Change::Mode(m))
        })),
        Some(Action::Open) => drop(std::thread::spawn(move || {
            crate::windows_ui::open_main(&app)
        })),
        None => {}
    }
}

pub fn problems(app: &AppHandle) -> Problems {
    app.state::<Hotkeys>().problems.lock().unwrap().clone()
}

/// Replaces every registered shortcut with the given set.
pub fn register(app: &AppHandle, set: &Shortcuts) -> Problems {
    let _ = app.global_shortcut().unregister_all();
    let mut active: Vec<(Shortcut, Action)> = Vec::new();
    let mut add = |keys: &Option<String>, action| -> Option<String> {
        let keys = keys.as_ref().filter(|_| set.enabled)?;
        let Ok(s) = Shortcut::from_str(keys) else {
            return Some("Windows can't use this shortcut.".into());
        };
        if active.iter().any(|(a, _)| *a == s) {
            return Some("Already used for another action here.".into());
        }
        if let Some(t) = typed_text(&s) {
            return Some(format!("Types “{t}” on one of your keyboard layouts."));
        }
        if app.global_shortcut().register(s).is_err() {
            return Some("Already used by another app.".into());
        }
        active.push((s, action));
        None
    };
    let p = Problems {
        anc: add(&set.anc, Action::Set(Mode::Anc)),
        transparency: add(&set.transparency, Action::Set(Mode::Transparency)),
        off: add(&set.off, Action::Set(Mode::Off)),
        open: add(&set.open, Action::Open),
    };
    let state = app.state::<Hotkeys>();
    *state.active.lock().unwrap() = active;
    *state.problems.lock().unwrap() = p.clone();
    p
}

/// On many layouts AltGr is Ctrl+Alt, so a shortcut could swallow a character the user types.
fn typed_text(s: &Shortcut) -> Option<String> {
    if !s.mods.contains(Modifiers::CONTROL | Modifiers::ALT) {
        return None;
    }
    let name = s.key.to_string();
    let key = name
        .strip_prefix("Key")
        .or_else(|| name.strip_prefix("Digit"))?
        .bytes()
        .next()?;
    let mut keys = [0u8; 256];
    for vk in [VK_CONTROL, VK_MENU] {
        keys[usize::from(vk.0)] = 0x80;
    }
    if s.mods.contains(Modifiers::SHIFT) {
        keys[usize::from(VK_SHIFT.0)] = 0x80;
    }
    unsafe {
        let mut layouts = vec![HKL::default(); GetKeyboardLayoutList(None).max(0) as usize];
        GetKeyboardLayoutList(Some(&mut layouts));
        layouts.into_iter().find_map(|l| {
            let mut out = [0u16; 8];
            // flag 4: leave the keyboard state alone
            let n = ToUnicodeEx(u32::from(key), 0, &keys, &mut out, 4, Some(l));
            let t = String::from_utf16_lossy(&out[..n.max(0) as usize]);
            (n > 0 && !t.chars().any(char::is_control)).then_some(t)
        })
    }
}
