//! L'icône de la zone de notification : là où vit l'application une fois ses
//! fenêtres fermées, tant que le bot tourne.

use std::sync::Mutex;
use std::thread;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::supervisor::{self, Phase};

/// Les entrées dont l'état suit celui du bot.
pub struct TrayItems {
    browser: MenuItem<Wry>,
    restart: MenuItem<Wry>,
    shutdown: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
}

pub struct TrayState(pub Mutex<Option<TrayItems>>);

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Ouvrir Interactive Music Player", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", "Ouvrir dans le navigateur", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Redémarrer le bot", false, None::<&str>)?;
    let shutdown = MenuItem::with_id(app, "shutdown", "Éteindre le bot", false, None::<&str>)?;
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart =
        CheckMenuItem::with_id(app, "autostart", "Lancer au démarrage de Windows", true, enabled, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Ouvrir les journaux", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &browser,
            &PredefinedMenuItem::separator(app)?,
            &restart,
            &shutdown,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &logs,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Interactive Music Player")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                supervisor::get(tray.app_handle()).show_main();
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    if let Some(state) = app.try_state::<TrayState>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(TrayItems { browser, restart, shutdown, quit, autostart });
    }
    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    let supervisor = supervisor::get(app);
    match id {
        "open" => supervisor.show_main(),
        "browser" => {
            thread::spawn(move || supervisor.open_in_browser());
        }
        "restart" => {
            thread::spawn(move || supervisor.restart());
        }
        "shutdown" => supervisor.confirm_shutdown(),
        "logs" => supervisor.open_logs(),
        "autostart" => toggle_autostart(app),
        "quit" => {
            thread::spawn(move || supervisor.quit());
        }
        _ => {}
    }
}

fn toggle_autostart(app: &AppHandle) {
    let launcher = app.autolaunch();
    let enabled = launcher.is_enabled().unwrap_or(false);
    let _ = if enabled { launcher.disable() } else { launcher.enable() };
    let now = launcher.is_enabled().unwrap_or(false);
    if let Some(state) = app.try_state::<TrayState>() {
        if let Some(items) = state.0.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            let _ = items.autostart.set_checked(now);
        }
    }
}

/// Accorde le menu à l'état du bot.
pub fn refresh(app: &AppHandle, phase: Phase) {
    let Some(state) = app.try_state::<TrayState>() else { return };
    let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let Some(items) = guard.as_ref() else { return };
    let alive = matches!(phase, Phase::Running | Phase::Attached);
    let _ = items.browser.set_enabled(alive);
    let _ = items.restart.set_enabled(alive);
    let _ = items.shutdown.set_enabled(alive);
    let quit_label = if matches!(phase, Phase::Running | Phase::Restarting | Phase::Launching) {
        "Éteindre le bot et quitter"
    } else {
        "Quitter"
    };
    let _ = items.quit.set_text(quit_label);
    let tooltip = match phase {
        Phase::Running | Phase::Attached => "Interactive Music Player — le bot tourne",
        Phase::Launching | Phase::Restarting => "Interactive Music Player — démarrage…",
        Phase::Stopping => "Interactive Music Player — extinction…",
        Phase::Setup => "Interactive Music Player — configuration",
        Phase::Idle => "Interactive Music Player — bot arrêté",
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}
