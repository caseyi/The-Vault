// Prevent an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// Fixed loopback port the bundled backend listens on.
const PORT: u16 = 8484;

// Holds the spawned backend process so we can kill/restart it.
struct Backend(Mutex<Option<Child>>);

#[derive(Default, Serialize, Deserialize)]
struct Config {
    #[serde(default, rename = "libraryPath")]
    library_path: String,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("config.json"))
}

fn read_config(app: &AppHandle) -> Config {
    config_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, cfg: &Config) {
    if let (Some(p), Ok(s)) = (config_path(app), serde_json::to_string_pretty(cfg)) {
        if let Some(dir) = p.parent() { let _ = fs::create_dir_all(dir); }
        let _ = fs::write(p, s);
    }
}

// Start the Node backend with the given library path (empty = none yet).
fn spawn_backend(app: &AppHandle, library_path: &str) -> Option<Child> {
    let resource_dir = app.path().resource_dir().ok()?;
    let data_dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(&data_dir);
    let _ = fs::create_dir_all(data_dir.join("images"));

    let backend_dir = resource_dir.join("resources").join("backend");
    let server_js = backend_dir.join("server.js");

    let bundled_node = resource_dir
        .join("resources").join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let node_bin = if bundled_node.exists() {
        bundled_node.to_string_lossy().to_string()
    } else {
        "node".to_string()
    };

    let mut cmd = Command::new(node_bin);
    cmd.arg("--disable-warning=ExperimentalWarning")
        .arg(&server_js)
        .env("PORT", PORT.to_string())
        .env("DB_PATH", data_dir.join("vault.db"))
        .env("IMAGES_DIR", data_dir.join("images"))
        // Use the stable app-data dir as cwd, not the app bundle: a quarantined/
        // translocated bundle path can vanish mid-run and break worker_threads
        // with "uv_cwd ENOENT". The backend resolves its own files via absolute
        // paths, so cwd doesn't otherwise matter.
        .current_dir(&data_dir);
    if !library_path.is_empty() {
        cmd.env("LIBRARY_PATH", library_path);
    }
    cmd.spawn().ok()
}

#[tauri::command]
fn get_library_path(app: AppHandle) -> String {
    read_config(&app).library_path
}

// Persist a chosen library folder and restart the backend so it indexes it.
#[tauri::command]
fn set_library_path(app: AppHandle, state: State<Backend>, path: String) -> Result<(), String> {
    let mut cfg = read_config(&app);
    cfg.library_path = path.clone();
    write_config(&app, &cfg);

    if let Some(mut child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }
    let child = spawn_backend(&app, &path).ok_or("failed to restart backend")?;
    *state.0.lock().unwrap() = Some(child);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![get_library_path, set_library_path])
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = read_config(&handle);
            if let Some(child) = spawn_backend(&handle, &cfg.library_path) {
                *app.state::<Backend>().0.lock().unwrap() = Some(child);
            } else {
                eprintln!("Failed to start backend");
            }

            // Rewrite the frontend's relative API/SSE calls to the local backend,
            // so the existing React app runs unmodified.
            let init = format!(
                "window.__VAULT_API__='http://127.0.0.1:{port}';\
                 (function(){{\
                   var base=window.__VAULT_API__;\
                   var of=window.fetch;\
                   window.fetch=function(u,o){{if(typeof u==='string'&&(u.indexOf('/api')===0||u.indexOf('/images')===0))u=base+u;return of(u,o);}};\
                   var OE=window.EventSource;\
                   if(OE){{window.EventSource=function(u,c){{if(typeof u==='string'&&(u.indexOf('/api')===0||u.indexOf('/images')===0))u=base+u;return new OE(u,c);}};}}\
                 }})();",
                port = PORT
            );

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("The Vault")
                .inner_size(1280.0, 860.0)
                .resizable(true)
                .initialization_script(&init)
                .build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<Backend>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running The Vault");
}
