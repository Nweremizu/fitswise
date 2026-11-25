use crate::bt::protocol::{Battery, Mode};
use crate::controller::{self, Buds, Change, Status};
use crate::windows_ui;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

const MODES: [(&str, &str, Mode); 3] = [
    ("anc", "Noise cancelling", Mode::Anc),
    ("transparency", "Transparency", Mode::Transparency),
    ("off", "Off", Mode::Off),
];

struct Items {
    modes: Vec<(Mode, CheckMenuItem<Wry>)>,
    startup: CheckMenuItem<Wry>,
    update: MenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let modes = MODES
        .iter()
        .map(|(id, text, m)| {
            let item = CheckMenuItem::with_id(app, *id, *text, false, false, None::<&str>)?;
            Ok((*m, item))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let on = app.autolaunch().is_enabled().unwrap_or(false);
    let startup =
        CheckMenuItem::with_id(app, "startup", "Start with Windows", true, on, None::<&str>)?;
    let open = MenuItem::with_id(
        app,
        "open",
        format!("Open {}", crate::NAME),
        true,
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let line = || PredefinedMenuItem::separator(app);
    let (l1, l2, l3) = (line()?, line()?, line()?);
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &l1,
            &modes[0].1,
            &modes[1].1,
            &modes[2].1,
            &l2,
            &startup,
            &update,
            &l3,
            &quit,
        ],
    )?;
    app.manage(Items {
        modes,
        startup,
        update,
    });

    let mut tray = TrayIconBuilder::with_id("tray")
        .tooltip(crate::NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| menu_clicked(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                std::thread::spawn(move || windows_ui::open_main(&app));
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn menu_clicked(app: &AppHandle, id: &str) {
    let app = app.clone();
    match id {
        "quit" => app.exit(0),
        "open" => drop(std::thread::spawn(move || windows_ui::open_main(&app))),
        "update" => {
            tauri::async_runtime::spawn(async move {
                if crate::updates::state(&app).version.is_some() {
                    let _ = crate::updates::install(&app).await;
                } else if crate::updates::check(&app).await == Ok(false) {
                    set_update_text(&app, "FitsWise is up to date");
                }
            });
        }
        "startup" => {
            let on = app.autolaunch().is_enabled().unwrap_or(false);
            crate::set_startup(&app, !on);
        }
        _ => {
            if let Some(m) = MODES.iter().find(|(i, _, _)| *i == id).map(|(_, _, m)| *m) {
                std::thread::spawn(move || {
                    let c = controller::get(&app);
                    let _ = c.apply(Change::Mode(m));
                    refresh(&app, &c.snapshot()); // Windows ticks the item itself; put it right
                });
            }
        }
    }
}

pub fn set_startup(app: &AppHandle, on: bool) {
    if let Some(i) = app.try_state::<Items>() {
        let _ = i.startup.set_checked(on);
    }
}

pub fn set_update(app: &AppHandle, version: Option<&str>) {
    let text = version.map_or("Check for updates".into(), |v| {
        format!("Install FitsWise {v}")
    });
    set_update_text(app, &text);
}

fn set_update_text(app: &AppHandle, text: &str) {
    if let Some(i) = app.try_state::<Items>() {
        let _ = i.update.set_text(text);
    }
}

pub fn refresh(app: &AppHandle, b: &Buds) {
    if let Some(items) = app.try_state::<Items>() {
        for (m, item) in &items.modes {
            let _ = item.set_enabled(b.status == Status::Connected);
            let _ = item.set_checked(b.mode == Some(*m));
        }
    }
    if let Some(tray) = app.tray_by_id("tray") {
        let _ = tray.set_tooltip(Some(tooltip(b)));
    }
}

fn tooltip(b: &Buds) -> String {
    let name = b.name.as_deref().unwrap_or(crate::NAME);
    match b.status {
        Status::Connected => format!("{name}\n{}", levels(&b.battery)),
        Status::Connecting => format!("{name}\nConnecting"),
        Status::Silent => format!("{name}\nNot answering"),
        Status::BluetoothOff => format!("{}\nBluetooth is off", crate::NAME),
        _ => format!("{}\nNot connected", crate::NAME),
    }
}

fn levels(b: &Battery) -> String {
    [("Left", b.left), ("Right", b.right), ("Case", b.case)]
        .into_iter()
        .filter_map(|(n, c)| c.map(|c| format!("{n} {}%", c.percent)))
        .collect::<Vec<_>>()
        .join("   ")
}
