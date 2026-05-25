use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize)]
struct OpenedFile {
    name: String,
    source: String,
}

fn read_dbml<P: Into<PathBuf>>(path: P) -> Option<OpenedFile> {
    let path = path.into();
    let source = std::fs::read_to_string(&path).ok()?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("(opened file)")
        .to_string();
    Some(OpenedFile { name, source })
}

// Holds the file passed via argv on first launch until the frontend asks for it.
struct PendingOpen(Mutex<Option<OpenedFile>>);

#[tauri::command]
fn take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<OpenedFile> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = std::env::args().nth(1).and_then(read_dbml);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(payload) = args.into_iter().nth(1).and_then(read_dbml) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                    let _ = window.emit("dbml-open", payload);
                }
            }
        }))
        .manage(PendingOpen(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![take_pending_open])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
