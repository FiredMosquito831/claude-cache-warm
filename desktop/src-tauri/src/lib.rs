//! Claude Cache Warm tray app.
//!
//! Deliberately thin: the dashboard (`node dashboard/server.mjs`) is the real UI.
//! This process owns a tray icon, toggles a couple of keys in `config.json`, makes
//! sure the dashboard server is running and shows it in a window.
//! See `docs/CONTRACT.md` for the shared state dir and HTTP API.

use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime},
};

use serde_json::{json, Map, Value};
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, SubmenuBuilder},
    path::BaseDirectory,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WindowEvent, Wry,
};

const MAIN_WINDOW: &str = "main";
const DEFAULT_PORT: u16 = 4777;
const ID_OPEN: &str = "open";
const ID_ENABLED: &str = "enabled";
const ID_QUIT: &str = "quit";
const INTERVAL_PREFIX: &str = "interval:";
/// (menu id suffix / config value, label). "auto" is written as a string, the rest as numbers.
const INTERVALS: &[(&str, &str)] = &[
    ("auto", "Auto"),
    ("4", "4 min"),
    ("15", "15 min"),
    ("30", "30 min"),
    ("50", "50 min"),
];

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CCW_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude-cache-warm")
}

fn config_path() -> PathBuf {
    state_dir().join("config.json")
}

fn default_config() -> Map<String, Value> {
    match json!({
        "enabled": true,
        "intervalMinutes": "auto",
        "maxIdleMinutes": 180,
        "minContextTokens": 20000,
        "engine": "monitor",
        "dashboardPort": DEFAULT_PORT
    }) {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

/// Reads config.json. `None` when the file is missing or not a JSON object.
fn read_config_file() -> Option<Map<String, Value>> {
    let text = fs::read_to_string(config_path()).ok()?;
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Contract defaults overlaid with whatever is on disk (unknown keys are preserved).
fn load_config() -> Map<String, Value> {
    let mut cfg = default_config();
    if let Some(on_disk) = read_config_file() {
        for (k, v) in on_disk {
            cfg.insert(k, v);
        }
    }
    cfg
}

/// Atomic write per the contract: `<file>.<pid>.tmp`, then rename over the target.
fn write_config(cfg: &Map<String, Value>) -> std::io::Result<()> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_file_name(format!("config.json.{}.tmp", std::process::id()));
    let mut body = serde_json::to_string_pretty(cfg).map_err(std::io::Error::other)?;
    body.push('\n');
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Read-modify-write a single key, keeping every other key intact.
fn patch_config(key: &str, value: Value) {
    let mut cfg = load_config();
    cfg.insert(key.to_string(), value);
    if let Err(err) = write_config(&cfg) {
        eprintln!("[ccw] failed to write {}: {err}", config_path().display());
    }
}

fn config_mtime() -> Option<SystemTime> {
    fs::metadata(config_path()).and_then(|m| m.modified()).ok()
}

fn dashboard_port(cfg: &Map<String, Value>) -> u16 {
    cfg.get("dashboardPort")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .unwrap_or(DEFAULT_PORT)
}

fn dashboard_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// The config's `intervalMinutes` as a menu id suffix ("auto", "4", ...).
fn interval_key(cfg: &Map<String, Value>) -> String {
    match cfg.get("intervalMinutes") {
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Some(Value::String(s)) => s.clone(),
        _ => "auto".into(),
    }
}

// ---------------------------------------------------------------------------
// Dashboard server
// ---------------------------------------------------------------------------

/// `GET /api/health` with std only (keeps the dependency tree small).
fn health_ok(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(700)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
    let request =
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    let mut filled = 0;
    while filled < 12 {
        match stream.read(&mut buf[filled..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => filled += n,
        }
    }
    // "HTTP/1.x 200"
    let head = &buf[..filled];
    head.starts_with(b"HTTP/1.") && head.get(8..12) == Some(b" 200".as_slice())
}

/// Resolution order: `CCW_DASHBOARD_SERVER`, bundled resource, then `dashboard/server.mjs`
/// next to / above the executable, then relative to the cargo manifest dir (dev).
fn resolve_server_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CCW_DASHBOARD_SERVER").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
        eprintln!("[ccw] CCW_DASHBOARD_SERVER does not exist: {}", p.display());
    }

    if let Ok(p) = app.path().resolve("dashboard/server.mjs", BaseDirectory::Resource) {
        if p.is_file() {
            return Some(p);
        }
    }

    let rel = Path::new("dashboard").join("server.mjs");
    if let Ok(exe) = std::env::current_exe() {
        // `<exe dir>/../dashboard/server.mjs`, then keep walking up (covers
        // `desktop/src-tauri/target/<profile>/` -> repo root during development).
        for dir in exe.ancestors().skip(1) {
            let candidate = dir.join(&rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join(&rel);
    dev.is_file().then_some(dev)
}

fn spawn_server(script: &Path) -> std::io::Result<Child> {
    let node = std::env::var_os("CCW_NODE").unwrap_or_else(|| "node".into());
    let mut cmd = Command::new(node);
    cmd.arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = script.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

struct AppState {
    /// The server process, only when *we* spawned it.
    server: Mutex<Option<Child>>,
    enabled_item: CheckMenuItem<Wry>,
    interval_items: Vec<(&'static str, CheckMenuItem<Wry>)>,
}

/// Spawns the dashboard server unless something already answers the health check
/// or our own child is still alive (i.e. still booting).
fn ensure_server(app: &AppHandle) {
    let port = dashboard_port(&load_config());
    if health_ok(port) {
        return;
    }
    let state = app.state::<AppState>();
    let mut guard = state.server.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return;
        }
        *guard = None;
    }
    let Some(script) = resolve_server_path(app) else {
        eprintln!("[ccw] dashboard/server.mjs not found; set CCW_DASHBOARD_SERVER");
        return;
    };
    match spawn_server(&script) {
        Ok(child) => *guard = Some(child),
        Err(err) => eprintln!("[ccw] failed to start `node {}`: {err}", script.display()),
    }
}

fn kill_server(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let child = state.server.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Shows the window immediately (fallback page if needed), then off the main thread
/// makes sure the server runs and points the webview at it once it is healthy.
fn open_dashboard(app: &AppHandle) {
    show_main_window(app);
    let app = app.clone();
    std::thread::spawn(move || {
        ensure_server(&app);
        let port = dashboard_port(&load_config());
        if !health_ok(port) {
            return; // the fallback page keeps retrying and redirects by itself
        }
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let target = dashboard_url(port);
        let on_dashboard = window
            .url()
            .map(|u| u.as_str().starts_with(&target))
            .unwrap_or(false);
        if !on_dashboard {
            if let Ok(url) = target.parse() {
                let _ = window.navigate(url);
            }
        }
    });
}

/// Mirrors config.json into the tray check items.
fn sync_menu(app: &AppHandle) {
    let cfg = load_config();
    let state = app.state::<AppState>();
    let enabled = cfg.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let _ = state.enabled_item.set_checked(enabled);
    let current = interval_key(&cfg);
    for (key, item) in &state.interval_items {
        let _ = item.set_checked(*key == current);
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        ID_OPEN => open_dashboard(app),
        ID_QUIT => app.exit(0),
        ID_ENABLED => {
            let enabled = load_config()
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            patch_config("enabled", Value::Bool(!enabled));
            sync_menu(app);
        }
        other => {
            if let Some(key) = other.strip_prefix(INTERVAL_PREFIX) {
                let value = match key.parse::<u64>() {
                    Ok(minutes) => json!(minutes),
                    Err(_) => json!("auto"),
                };
                patch_config("intervalMinutes", value);
                // Also undoes the OS auto-toggle when the active item is clicked again.
                sync_menu(app);
            }
        }
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let cfg = load_config();

    let open_item = MenuItem::with_id(app, ID_OPEN, "Open dashboard", true, None::<&str>)?;
    let enabled_item = CheckMenuItemBuilder::with_id(ID_ENABLED, "Warming enabled")
        .checked(cfg.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        .build(app)?;

    let current = interval_key(&cfg);
    let mut interval_items = Vec::with_capacity(INTERVALS.len());
    let mut interval_menu = SubmenuBuilder::new(app, "Interval");
    for (key, label) in INTERVALS {
        let item = CheckMenuItemBuilder::with_id(format!("{INTERVAL_PREFIX}{key}"), *label)
            .checked(*key == current)
            .build(app)?;
        interval_menu = interval_menu.item(&item);
        interval_items.push((*key, item));
    }
    let interval_menu = interval_menu.build()?;
    let quit_item = MenuItem::with_id(app, ID_QUIT, "Quit", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .item(&enabled_item)
        .item(&interval_menu)
        .separator()
        .item(&quit_item)
        .build()?;

    app.manage(AppState {
        server: Mutex::new(None),
        enabled_item,
        interval_items,
    });

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Claude Cache Warm")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_dashboard(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands (local fallback page only)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct DashboardStatus {
    url: String,
    healthy: bool,
}

#[tauri::command]
async fn dashboard_status() -> DashboardStatus {
    let port = dashboard_port(&load_config());
    DashboardStatus {
        url: dashboard_url(port),
        healthy: health_ok(port),
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run() {
    let app = tauri::Builder::default()
        // Must be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_dashboard(app);
        }))
        .invoke_handler(tauri::generate_handler![dashboard_status])
        .on_window_event(|window, event| {
            // Closing the window hides it; only the tray "Quit" exits.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // Create config.json with the contract defaults on first run.
            if read_config_file().is_none() && !config_path().exists() {
                if let Err(err) = write_config(&default_config()) {
                    eprintln!("[ccw] failed to create {}: {err}", config_path().display());
                }
            }

            build_tray(app)?;

            // Start the dashboard server if nobody is serving it yet.
            let handle = app.handle().clone();
            std::thread::spawn(move || ensure_server(&handle));

            // Pick up external edits to config.json (CLI, dashboard): poll the mtime.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last = config_mtime();
                loop {
                    std::thread::sleep(Duration::from_secs(3));
                    let now = config_mtime();
                    if now != last {
                        last = now;
                        sync_menu(&handle);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Claude Cache Warm");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            kill_server(app);
        }
    });
}
