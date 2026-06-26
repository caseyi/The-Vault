// Prevent an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// Fixed loopback port the bundled backend listens on.
const PORT: u16 = 8484;

// Holds the spawned backend process so we can kill it on quit.
struct Backend(Mutex<Option<Child>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();
            std::fs::create_dir_all(data_dir.join("images")).ok();

            let backend_dir = resource_dir.join("resources").join("backend");
            let server_js = backend_dir.join("server.js");

            // Prefer a bundled Node runtime; fall back to a `node` on PATH.
            let bundled_node = resource_dir
                .join("resources")
                .join("node")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
            let node_bin = if bundled_node.exists() {
                bundled_node.to_string_lossy().to_string()
            } else {
                "node".to_string()
            };

            // TODO(M3): read a saved LIBRARY_PATH from app config and pass it here;
            // until then the user sets it via the in-app folder picker + Settings.
            let child = Command::new(node_bin)
                .arg("--disable-warning=ExperimentalWarning")
                .arg(&server_js)
                .env("PORT", PORT.to_string())
                .env("DB_PATH", data_dir.join("vault.db"))
                .env("IMAGES_DIR", data_dir.join("images"))
                .current_dir(&backend_dir)
                .spawn();

            match child {
                Ok(c) => { *app.state::<Backend>().0.lock().unwrap() = Some(c); }
                Err(e) => { eprintln!("Failed to start backend: {e}"); }
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
