use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shortcuts {
    pub enabled: bool,
    pub anc: Option<String>,
    pub transparency: Option<String>,
    pub off: Option<String>,
    pub open: Option<String>,
}

impl Default for Shortcuts {
    fn default() -> Self {
        let key = |k: &str| Some(format!("Ctrl+Alt+Shift+{k}"));
        Self {
            enabled: true,
            anc: key("1"),
            transparency: key("2"),
            off: key("3"),
            open: key("B"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub popup_on_connect: bool,
    pub low_battery_popup: bool,
    /// The first-run question about starting with Windows has been answered.
    pub asked_startup: bool,
    pub check_updates: bool,
    pub shortcuts: Shortcuts,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            popup_on_connect: true,
            low_battery_popup: true,
            asked_startup: false,
            check_updates: true,
            shortcuts: Shortcuts::default(),
        }
    }
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("settings.json"))
}

/// A missing or damaged file gives the defaults.
pub fn load(app: &AppHandle) -> Settings {
    path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Writes beside the real file and swaps it in, so a crash can't leave half a file.
pub fn save(app: &AppHandle, s: &Settings) -> std::io::Result<()> {
    let p = path(app).ok_or(std::io::ErrorKind::NotFound)?;
    std::fs::create_dir_all(p.parent().unwrap_or(&p))?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
    std::fs::rename(tmp, p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_or_partial_files_keep_working() {
        let s: Settings =
            serde_json::from_str(r#"{"popupOnConnect":false,"shortcuts":{"open":null},"later":1}"#)
                .unwrap();
        assert!(!s.popup_on_connect && s.low_battery_popup);
        assert_eq!(s.shortcuts.open, None);
        assert_eq!(s.shortcuts.anc.as_deref(), Some("Ctrl+Alt+Shift+1"));
    }
}
