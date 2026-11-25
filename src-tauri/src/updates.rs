//! Checks GitHub for a newer signed release and installs it when the user asks.
//!
//! The feed is `latest.json` on the newest GitHub release, written by the release workflow. Every
//! installer is signed; the public key is in tauri.conf.json, so a tampered download is refused.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// The newer version on offer, if any.
    pub version: Option<String>,
    pub notes: Option<String>,
    /// Set while downloading: bytes so far and in total, when known.
    pub progress: Option<(u64, Option<u64>)>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Updates {
    state: Mutex<UpdateState>,
    found: Mutex<Option<Update>>,
}

fn set(app: &AppHandle, f: impl FnOnce(&mut UpdateState)) {
    let s = {
        let me = app.state::<Updates>();
        let mut s = me.state.lock().unwrap();
        f(&mut s);
        s.clone()
    };
    crate::tray::set_update(app, s.version.as_deref());
    let _ = app.emit("update", &s);
}

pub fn state(app: &AppHandle) -> UpdateState {
    app.state::<Updates>().state.lock().unwrap().clone()
}

fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    app.updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
}

/// Asks once. `Ok(true)` means a newer version is on offer.
pub async fn check(app: &AppHandle) -> Result<bool, String> {
    let found = updater(app)
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|_| "Couldn't reach the update server. Check your connection.".to_string())?;
    let me = app.state::<Updates>();
    let offer = found.as_ref().map(|u| (u.version.clone(), u.body.clone()));
    *me.found.lock().unwrap() = found;
    set(app, |s| {
        s.error = None;
        s.version = offer.as_ref().map(|o| o.0.clone());
        s.notes = offer
            .clone()
            .and_then(|o| o.1)
            .filter(|n| !n.trim().is_empty());
    });
    Ok(offer.is_some())
}

/// Downloads, checks the signature and runs the installer. Windows closes the app to install it,
/// and the installer starts it again.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let Some(update) = app.state::<Updates>().found.lock().unwrap().clone() else {
        return Err("There's no update to install.".into());
    };
    set(app, |s| {
        s.error = None;
        s.progress = Some((0, None));
    });
    let mut done = 0u64;
    let result = update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                // ponytail: one event per chunk is fine for a few MB; throttle if releases grow
                set(app, |s| s.progress = Some((done, total)));
            },
            || {},
        )
        .await;
    if let Err(e) = result {
        let message = if e.to_string().to_lowercase().contains("signature") {
            "The download wasn't signed by FitsWise, so it wasn't installed."
        } else {
            "The update couldn't be downloaded. Try again later."
        };
        set(app, |s| {
            s.progress = None;
            s.error = Some(message.into());
        });
        return Err(message.into());
    }
    Ok(())
}

/// Checks a little after start, then every few hours, while the setting allows it.
pub fn start(app: &AppHandle) {
    app.manage(Updates::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK).await;
        loop {
            let on = app
                .state::<Mutex<crate::settings::Settings>>()
                .lock()
                .unwrap()
                .check_updates;
            if on && state(&app).progress.is_none() {
                let _ = check(&app).await; // offline is normal; try again later
            }
            tokio_sleep(EVERY).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}
