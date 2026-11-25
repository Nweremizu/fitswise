pub mod bt;
mod controller;
mod hotkeys;
mod settings;
mod tray;
mod windows_ui;

use controller::{Buds, Change, Controller};
use hotkeys::{Hotkeys, Problems};
use serde::Serialize;
use settings::Settings;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use windows_ui::{PopupKind, PopupRequest};

/// Change the app's public name here (and in tauri.conf.json).
pub const NAME: &str = "FitsWise";
/// Passed by Windows at sign-in: start in the tray without a window.
const HIDDEN: &str = "--hidden";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: &'static str,
    version: String,
    settings: Settings,
    startup: bool,
    shortcut_problems: Problems,
}

#[tauri::command(async)]
fn get_buds(app: AppHandle) -> Buds {
    controller::get(&app).snapshot()
}

#[tauri::command(async)]
fn change(app: AppHandle, change: Change) -> Result<(), String> {
    controller::get(&app)
        .apply(change)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn get_app(app: AppHandle) -> AppInfo {
    AppInfo {
        name: NAME,
        version: app.package_info().version.to_string(),
        settings: app.state::<Mutex<Settings>>().lock().unwrap().clone(),
        startup: app.autolaunch().is_enabled().unwrap_or(false),
        shortcut_problems: hotkeys::problems(&app),
    }
}

#[tauri::command(async)]
fn save_settings(app: AppHandle, settings: Settings) -> Result<AppInfo, String> {
    settings::save(&app, &settings).map_err(|_| "The settings could not be saved.")?;
    let state = app.state::<Mutex<Settings>>();
    let old = std::mem::replace(&mut *state.lock().unwrap(), settings.clone());
    if old.shortcuts != settings.shortcuts {
        hotkeys::register(&app, &settings.shortcuts);
    }
    Ok(get_app(app.clone()))
}

fn set_startup(app: &AppHandle, on: bool) -> bool {
    let auto = app.autolaunch();
    let _ = if on { auto.enable() } else { auto.disable() };
    let now = auto.is_enabled().unwrap_or(false);
    tray::set_startup(app, now);
    let _ = tauri::Emitter::emit(app, "startup", now);
    now
}

#[tauri::command(async)]
fn start_with_windows(app: AppHandle, on: bool) -> Result<(), String> {
    if set_startup(&app, on) == on {
        Ok(())
    } else {
        Err("Windows didn't accept the change.".into())
    }
}

/// Windows stay hidden until their page has drawn, so nothing flashes white.
#[tauri::command(async)]
fn page_ready(app: AppHandle, window: WebviewWindow) {
    let _ = window.show();
    if window.label() == windows_ui::MAIN {
        let _ = window.set_focus();
    } else if std::env::var_os("FITSWISE_TIMING").is_some() {
        let asked = *app.state::<PopupRequest>().asked.lock().unwrap();
        eprintln!("popup visible after {} ms", asked.elapsed().as_millis());
    }
}

#[tauri::command(async)]
fn popup_request(app: AppHandle) -> PopupKind {
    *app.state::<PopupRequest>().kind.lock().unwrap()
}

#[tauri::command(async)]
fn close_popup(app: AppHandle) {
    if let Some(w) = app.get_webview_window(windows_ui::POPUP) {
        let _ = w.destroy();
    }
}

#[tauri::command(async)]
fn open_main(app: AppHandle) {
    windows_ui::open_main(&app);
}

pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let app = app.clone();
            std::thread::spawn(move || windows_ui::open_main(&app));
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN]),
        ))
        .plugin(hotkeys::plugin())
        .setup(|app| {
            let app = app.handle();
            let settings = settings::load(app);
            app.manage(Hotkeys::default());
            app.manage(PopupRequest::default());
            hotkeys::register(app, &settings.shortcuts);
            app.manage(Mutex::new(settings));
            tray::build(app)?;
            let controller: Arc<Controller> = Controller::start(app);
            app.manage(controller);
            if !std::env::args().any(|a| a == HIDDEN) {
                windows_ui::open_main(app);
            }
            // For measuring how fast the popup appears.
            if std::env::var_os("FITSWISE_TIMING").is_some() {
                windows_ui::show_popup(app, PopupKind::Connected);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_buds,
            change,
            get_app,
            save_settings,
            start_with_windows,
            page_ready,
            popup_request,
            close_popup,
            open_main
        ])
        .build(tauri::generate_context!())
        .expect("FitsWise could not start")
        .run(|_, event| {
            // Closing the last window leaves the tray running; only Quit passes an exit code.
            if let RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
