use std::path::PathBuf;
use std::sync::Mutex;

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

// Holds the file passed via argv on launch until the frontend asks for it.
// Each process owns its own instance — multiple desktop windows can run in
// parallel; recent-files state is synchronised between them via shared
// WebView2 localStorage in the frontend.
struct PendingOpen(Mutex<Option<OpenedFile>>);

#[tauri::command]
fn take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<OpenedFile> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = std::env::args().nth(1).and_then(read_dbml);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PendingOpen(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![take_pending_open])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
