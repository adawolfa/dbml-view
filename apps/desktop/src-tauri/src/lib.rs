use std::path::PathBuf;
use std::sync::Mutex;

use tauri_plugin_dialog::DialogExt;

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

// WebView2 silently drops blob-URL anchor downloads, so the diagram's
// "Export SVG" button dispatches a cancelable event that the shell catches
// and routes here. Returns `Ok(true)` if the file was written, `Ok(false)`
// if the user dismissed the dialog.
#[tauri::command]
async fn save_svg(
    app: tauri::AppHandle,
    content: String,
    default_filename: String,
) -> Result<bool, String> {
    let dialog_app = app.clone();
    let file_path = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("SVG", &["svg"])
            .set_file_name(&default_filename)
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file_path) = file_path else {
        return Ok(false);
    };
    let path: PathBuf = file_path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = std::env::args().nth(1).and_then(read_dbml);

    tauri::Builder::default()
        .plugin(
            // Restore size/position/maximized only — visibility is owned by the
            // frontend (window starts hidden to avoid a white flash; see
            // showTauriWindow in apps/web/src/main.ts).
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingOpen(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![take_pending_open, save_svg])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
