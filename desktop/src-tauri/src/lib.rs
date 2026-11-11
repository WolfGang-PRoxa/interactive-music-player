//! Interactive Music Player, en application de bureau.
//!
//! Une coquille autour du bot : elle prépare son dossier, le lance avec un
//! Node embarqué, le surveille, et montre son tableau de bord dans une fenêtre.
//! Le bot reste un serveur Node : le tableau de bord s'ouvre toujours dans
//! n'importe quel navigateur, sur cette machine comme ailleurs.

mod dashboard;
mod discord;
mod env_file;
mod layout;
mod payload;
mod supervisor;
mod tray;
mod view;

use std::sync::{Arc, Mutex};
use std::thread;

use tauri::{Manager, RunEvent, WindowEvent};

use supervisor::Supervisor;

/// L'instantané courant, pour la page qui vient de se charger.
#[tauri::command]
fn snapshot(app: tauri::AppHandle) -> view::Snapshot {
    supervisor::get(&app).snapshot()
}

/// Un bouton de la fenêtre de lancement.
///
/// Tout part sur un fil à part : les actions attendent le réseau, un
/// processus ou une boîte de dialogue, et rien ne doit figer la fenêtre.
#[tauri::command]
fn act(app: tauri::AppHandle, id: String, value: Option<String>) {
    let supervisor = supervisor::get(&app);
    thread::spawn(move || match id.as_str() {
        "start" => supervisor.start(),
        "quit" => supervisor.quit(),
        "open-logs" => supervisor.open_logs(),
        "open-dashboard" => supervisor.open_dashboard(),
        "open-browser" => supervisor.open_in_browser(),
        "restart" => supervisor.restart(),
        "shutdown" => supervisor.confirm_shutdown(),
        "confirm-shutdown" => supervisor.shutdown(),
        "cancel" => supervisor.cancel(),
        "reconfigure" => supervisor.reconfigure(),
        "open-portal" => supervisor.open_portal(),
        "submit-token" => supervisor.submit_token(value.unwrap_or_default()),
        "invite" => supervisor.invite_and_start(),
        "later" => supervisor.finish_setup(),
        "choose-folder" => supervisor.choose_folder(),
        "default-folder" => supervisor.use_default_folder(),
        _ => {}
    });
}

pub fn run() {
    let background = std::env::args().any(|arg| arg == "--background");

    let app = tauri::Builder::default()
        // En premier : une seconde ouverture ne lance rien, elle montre la
        // première.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            supervisor::get(app).show_main();
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(tray::TrayState(Mutex::new(None)))
        .setup(move |app| {
            let handle = app.handle().clone();
            let supervisor: Arc<Supervisor> = Supervisor::new(handle.clone(), background);
            app.manage(supervisor.clone());
            tray::build(&handle)?;
            if !background {
                supervisor.show_launcher();
            }
            supervisor.start();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let supervisor = supervisor::get(app);
                if supervisor.window_closing(window.label()) {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![snapshot, act])
        .build(tauri::generate_context!())
        .expect("l'application n'a pas pu démarrer");

    app.run(|app, event| match event {
        // Les fenêtres se cachent au lieu de se fermer ; une sortie sans code
        // ne vient donc que du système, qui ferme la dernière fenêtre.
        RunEvent::ExitRequested { code: None, api, .. } => {
            if supervisor::get(app).phase().bot_alive() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => supervisor::get(app).kill_now(),
        _ => {}
    });
}
