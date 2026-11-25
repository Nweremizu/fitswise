//! Windows are built when needed and destroyed when closed, so the tray app stays small.

use crate::settings::Settings;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::UI::Shell::{
    QUNS_ACCEPTS_NOTIFICATIONS, QUNS_APP, SHQueryUserNotificationState,
};

pub const MAIN: &str = "main";
pub const POPUP: &str = "popup";
/// As small as each card allows: the clear area around it still blocks clicks.
const CONNECTED_SIZE: LogicalSize<f64> = LogicalSize::new(360.0, 484.0);
const LOW_SIZE: LogicalSize<f64> = LogicalSize::new(360.0, 200.0);
const POPUP_GAP: f64 = 16.0;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "level")]
pub enum PopupKind {
    Connected,
    LowBattery(u8),
}

pub struct PopupRequest {
    pub kind: Mutex<PopupKind>,
    pub asked: Mutex<Instant>,
}

impl Default for PopupRequest {
    fn default() -> Self {
        Self {
            kind: Mutex::new(PopupKind::Connected),
            asked: Mutex::new(Instant::now()),
        }
    }
}

pub fn open_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title(crate::NAME)
        .inner_size(380.0, 600.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .visible(false) // the page shows itself once it has drawn, so there is no white flash
        .build();
    if let Err(e) = built {
        eprintln!("main window: {e}");
    }
}

/// False during fullscreen games and films, presentations and Do Not Disturb.
fn interruptible() -> bool {
    matches!(unsafe { SHQueryUserNotificationState() },
        Ok(s) if s == QUNS_ACCEPTS_NOTIFICATIONS || s == QUNS_APP)
}

fn settings(app: &AppHandle) -> Settings {
    app.state::<Mutex<Settings>>().lock().unwrap().clone()
}

pub fn connected(app: &AppHandle) {
    if settings(app).popup_on_connect {
        popup(app, PopupKind::Connected);
    }
}

pub fn low_battery(app: &AppHandle, level: u8) {
    if settings(app).low_battery_popup {
        popup(app, PopupKind::LowBattery(level));
    }
}

fn popup(app: &AppHandle, kind: PopupKind) {
    let main_focused = app
        .get_webview_window(MAIN)
        .is_some_and(|w| w.is_focused().unwrap_or(false));
    if !main_focused && interruptible() {
        show_popup(app, kind);
    }
}

pub fn show_popup(app: &AppHandle, kind: PopupKind) {
    let popup_size = match kind {
        PopupKind::Connected => CONNECTED_SIZE,
        PopupKind::LowBattery(_) => LOW_SIZE,
    };
    let req = app.state::<PopupRequest>();
    *req.kind.lock().unwrap() = kind;
    *req.asked.lock().unwrap() = Instant::now();
    if app.get_webview_window(POPUP).is_some() {
        return; // one card at a time; it already shows live battery
    }
    let built = WebviewWindowBuilder::new(app, POPUP, WebviewUrl::App("popup.html".into()))
        .title(crate::NAME)
        .inner_size(popup_size.width, popup_size.height)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build();
    let w = match built {
        Ok(w) => w,
        Err(e) => return eprintln!("popup window: {e}"),
    };
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let (k, area) = (m.scale_factor(), m.work_area());
        let size = popup_size.to_physical::<i32>(k);
        let x = area.position.x + (area.size.width as i32 - size.width) / 2;
        let y = area.position.y + area.size.height as i32 - size.height - (POPUP_GAP * k) as i32;
        let _ = w.set_position(PhysicalPosition::new(x, y));
        let _ = w.set_size(popup_size);
    }
}
