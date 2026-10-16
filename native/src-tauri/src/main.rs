// Prevent an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// How long to wait for the backend's /api/health after (re)starting it.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
/// Rotate backend.log once it grows beyond this.
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// The spawned backend process plus the loopback port it listens on. The port
/// is picked once per app run (the webview's init script is built with it), and
/// reused when the backend is restarted for a new library folder.
struct Backend {
    child: Mutex<Option<Child>>,
    port: u16,
    /// Bumped on every (re)start so a watcher for an older process stays quiet.
    generation: AtomicU64,
}

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
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(p, s);
    }
}

fn log_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("backend.log"))
        .unwrap_or_else(|_| PathBuf::from("backend.log"))
}

/// Ask the OS for a free loopback port. There is a tiny window between
/// dropping the listener and Node binding it; a clash shows up as a failed
/// health check with the reason in backend.log.
fn pick_free_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8484)
}

/// Open backend.log for appending, rotating it to backend.log.1 when large.
fn open_log(path: &Path) -> std::io::Result<File> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if fs::metadata(path).map(|m| m.len() > LOG_ROTATE_BYTES).unwrap_or(false) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    let _ = writeln!(f, "\n===== The Vault backend starting =====");
    Ok(f)
}

/// Start the Node backend with the given library path (empty = none yet).
fn spawn_backend(app: &AppHandle, library_path: &str, port: u16) -> Result<Child, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = fs::create_dir_all(&data_dir);
    let _ = fs::create_dir_all(data_dir.join("images"));

    let backend_dir = resource_dir.join("resources").join("backend");
    let server_js = backend_dir.join("server.js");

    let bundled_node = resource_dir
        .join("resources")
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let node_bin = if bundled_node.exists() {
        bundled_node.to_string_lossy().to_string()
    } else {
        "node".to_string()
    };

    let log = open_log(&log_path(app)).map_err(|e| format!("cannot open backend.log: {e}"))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(node_bin);
    cmd.arg("--disable-warning=ExperimentalWarning")
        .arg(&server_js)
        // Loopback only: the desktop backend must never be reachable from the LAN.
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("DB_PATH", data_dir.join("vault.db"))
        .env("IMAGES_DIR", data_dir.join("images"))
        .env("BACKUP_DIR", data_dir.join("backups"))
        // Use the stable app-data dir as cwd, not the app bundle: a quarantined/
        // translocated bundle path can vanish mid-run and break worker_threads
        // with "uv_cwd ENOENT". The backend resolves its own files via absolute
        // paths, so cwd doesn't otherwise matter.
        .current_dir(&data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    if !library_path.is_empty() {
        cmd.env("LIBRARY_PATH", library_path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("failed to start Node: {e}"))
}

/// Kill the backend (if running) and wait for it to exit, so its port and the
/// SQLite database are released before anything else starts.
fn stop_backend(state: &Backend) {
    let taken = state.child.lock().map(|mut g| g.take()).unwrap_or(None);
    if let Some(mut child) = taken {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// One minimal HTTP/1.0 GET of /api/health; true on a 200 response.
fn health_ok(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    if s
        .write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 32];
    let n = s.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// Poll /api/health in the background; if the backend dies or never answers,
/// show a native error dialog pointing at backend.log.
fn watch_startup(app: AppHandle) {
    thread::spawn(move || {
        let state = app.state::<Backend>();
        let port = state.port;
        let generation = state.generation.load(Ordering::SeqCst);
        let superseded = || state.generation.load(Ordering::SeqCst) != generation;
        let started = Instant::now();
        let mut reason = format!(
            "The backend did not answer on http://127.0.0.1:{port}/api/health within {}s.",
            HEALTH_TIMEOUT.as_secs()
        );
        loop {
            if superseded() || health_ok(port) {
                return;
            }
            // Did the process already exit (bad Node, crash on boot, port taken)?
            let exited = state
                .child
                .lock()
                .ok()
                .and_then(|mut g| g.as_mut().map(|c| c.try_wait()))
                .and_then(|r| r.ok())
                .flatten();
            match exited {
                Some(status) => {
                    reason = format!("The backend exited during start-up ({status}).");
                    break;
                }
                None if state.child.lock().map(|g| g.is_none()).unwrap_or(true) => {
                    reason = "The backend is not running.".to_string();
                    break;
                }
                None => {}
            }
            if started.elapsed() > HEALTH_TIMEOUT {
                break;
            }
            thread::sleep(Duration::from_millis(300));
        }
        if !superseded() {
            startup_error(&app, &reason);
        }
    });
}

fn startup_error(app: &AppHandle, reason: &str) {
    let log = log_path(app);
    eprintln!("{reason} Log: {}", log.display());
    app.dialog()
        .message(format!(
            "{reason}\n\nDetails are in the log file:\n{}\n\nTry quitting and reopening The Vault. If it keeps happening, please attach that file to a GitHub issue.",
            log.display()
        ))
        .kind(MessageDialogKind::Error)
        .title("The Vault could not start its library service")
        .show(|_| {});
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

    state.generation.fetch_add(1, Ordering::SeqCst);
    stop_backend(&state);
    let child = spawn_backend(&app, &path, state.port)?;
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);
    watch_startup(app.clone());
    Ok(())
}

fn main() {
    let port = pick_free_port();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend {
            child: Mutex::new(None),
            port,
            generation: AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![get_library_path, set_library_path])
        .setup(move |app| {
            let handle = app.handle().clone();
            let cfg = read_config(&handle);
            match spawn_backend(&handle, &cfg.library_path, port) {
                Ok(child) => {
                    if let Ok(mut g) = app.state::<Backend>().child.lock() {
                        *g = Some(child);
                    }
                    watch_startup(handle.clone());
                }
                Err(e) => startup_error(&handle, &e),
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
                 }})();"
            );

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("The Vault")
                .inner_size(1280.0, 860.0)
                .resizable(true)
                .initialization_script(&init)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building The Vault");

    app.run(|app, event| {
        // Kill AND reap the backend however the app ends (window closed, Cmd-Q,
        // Windows shutdown), so no orphaned node process keeps the DB open.
        if let RunEvent::Exit = event {
            if let Some(state) = app.try_state::<Backend>() {
                stop_backend(&state);
            }
        }
    });
}
