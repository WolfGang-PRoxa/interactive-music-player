// Sans console sous Windows, en version publiée comme en version installée :
// l'application vit dans sa fenêtre et dans la zone de notification. En
// développement, la console reste, pour lire ce que Tauri y écrit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    imp_desktop::run();
}
