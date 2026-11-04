// Wim's native app: a Tauri window for Wim's page, with the editor itself
// (Node, `wim.js --window=host`) running behind it.
//
// The window opens straight away, with Wim's background, while Node starts
// in the background; the page loads once Node says where it is. The two talk
// in lines of JSON over Node's stdin and stdout (see `openHost` in
// `src/window.ts`):
//
// - Node tells the app the page's address (`url`), the window's `title`,
//   and when to `activate` (after a file is dropped from another app).
// - The window's close button, and Quit from the Dock, don't close anything
//   themselves: the app sends `close` to Node, which decides (and warns
//   about unsaved changes first).
//
// When Node exits, so does the app; when the app exits, Node's stdin ends,
// and Node exits too.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod macos;

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{env, thread};

use serde::Deserialize;
use tauri::window::Color;
use tauri::{AppHandle, Manager, PhysicalSize, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// The page's background, so the window doesn't flash white while Wim
/// starts.
const BACKGROUND: Color = Color(0x28, 0x2c, 0x34, 0xff);
/// How much of Node's error output is kept, to show if it fails to start.
const ERROR_TAIL: usize = 4096;
/// How long the login shell may take to say what its environment is.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// What Node says to the app.
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum FromEditor {
    Url { url: String },
    Title { title: String },
    Activate,
}

/// The running editor, as far as the window needs it.
#[derive(Default)]
struct Editor {
    /// Node's stdin, while it runs.
    stdin: Mutex<Option<ChildStdin>>,
}

impl Editor {
    /// Ask Node to close, as the close button does. False if Node isn't
    /// running, so there is nothing to ask.
    fn request_close(&self) -> bool {
        match self.stdin.lock().unwrap().as_mut() {
            Some(stdin) => stdin.write_all(b"{\"t\":\"close\"}\n").and_then(|()| stdin.flush()).is_ok(),
            None => false,
        }
    }
}

fn main() {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let editor = Arc::new(Editor::default());
    // Node starts while the window opens.
    let (app_sender, app_receiver) = mpsc::channel();
    thread::spawn({
        let editor = editor.clone();
        move || run_editor(app_receiver, editor, args)
    });

    let app = tauri::Builder::default()
        // Without a menu, Cmd shortcuts (Cmd+Q, Cmd+C, ...) go to the page,
        // as in the other windows.
        .enable_macos_default_menu(false)
        .manage(editor.clone())
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Wim")
                .inner_size(1000.0, 720.0)
                .min_inner_size(320.0, 200.0)
                .visible(false)
                .background_color(BACKGROUND)
                // Let files dropped on the window reach the page.
                .disable_drag_drop_handler()
                .build()?;
            // Fill the screen apart from the menu bar and Dock, as a window
            // rather than in full screen mode. Not `maximized`: zooming
            // there animates, which holds up Wim's first frame by a third
            // of a second.
            if let Some(screen) = window.primary_monitor()? {
                let area = screen.work_area();
                let border = window.outer_size()?.height.saturating_sub(window.inner_size()?.height);
                window.set_position(area.position)?;
                window.set_size(PhysicalSize::new(area.size.width, area.size.height.saturating_sub(border)))?;
            }
            window.show()?;
            // Started from a terminal, the app isn't active, so take focus.
            window.set_focus()?;
            #[cfg(target_os = "macos")]
            {
                let editor = editor.clone();
                macos::on_quit(move || editor.request_close());
            }
            let _ = app_sender.send(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Arc<Editor>>().request_close() {
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("wim: could not start the window");
    app.run(|_, _: RunEvent| {});
}

/// Start Node and pass on what it says until it exits, then quit (or, if it
/// never got as far as showing the page, show why in the window). `app`
/// comes once the window is open.
fn run_editor(app: Receiver<AppHandle>, editor: Arc<Editor>, args: Vec<OsString>) {
    let launched_from_desktop = launched_from_desktop();
    let shell_env = if launched_from_desktop { login_shell_env() } else { None };
    let path = shell_env.as_ref().and_then(|vars| vars.iter().find(|(k, _)| k == "PATH")).map(|(_, v)| v.clone());

    let (node, wim) = match (find_node(path.as_deref()), find_wim()) {
        (Ok(node), Ok(wim)) => (node, wim),
        (Err(e), _) | (_, Err(e)) => return show_error(app.recv().ok().as_ref(), &e),
    };
    let mut command = Command::new(&node);
    command.arg(&wim).arg("--window=host").args(&args);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(vars) = shell_env {
        command.env_clear().envs(vars);
    }
    // Opened from the Finder, the Dock or `open`, Wim starts in the home
    // directory rather than in `/`.
    if env::current_dir().is_ok_and(|d| d == Path::new("/")) {
        if let Some(home) = env::var_os("HOME") {
            command.current_dir(home);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return show_error(app.recv().ok().as_ref(), &format!("Could not run {}: {e}", node.display())),
    };
    *editor.stdin.lock().unwrap() = child.stdin.take();
    let Ok(app) = app.recv() else { return };

    // Pass Node's errors on, keeping the last of them in case it fails.
    let errors = Arc::new(Mutex::new(Vec::new()));
    let stderr_thread = child.stderr.take().map(|mut stderr| {
        let errors = errors.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n @ 1..) = stderr.read(&mut buf) {
                let _ = std::io::stderr().write_all(&buf[..n]);
                let mut errors = errors.lock().unwrap();
                errors.extend_from_slice(&buf[..n]);
                let excess = errors.len().saturating_sub(ERROR_TAIL);
                errors.drain(..excess);
            }
        })
    });

    let mut shown = false;
    for line in BufReader::new(child.stdout.take().unwrap()).lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<FromEditor>(&line) else {
            // Not for the app.
            println!("{line}");
            continue;
        };
        let Some(window) = app.get_webview_window("main") else { continue };
        match msg {
            FromEditor::Url { url } => match url.parse() {
                Ok(url) => shown = window.navigate(url).is_ok(),
                Err(e) => eprintln!("wim: bad address from the editor: {e}"),
            },
            FromEditor::Title { title } => {
                let _ = window.set_title(&title);
            }
            FromEditor::Activate => {
                let _ = window.set_focus();
            }
        }
    }

    *editor.stdin.lock().unwrap() = None;
    let status = child.wait();
    if let Some(thread) = stderr_thread {
        let _ = thread.join();
    }
    if shown {
        // Quitting Wim ends here. Otherwise the page says Wim has stopped
        // until the window is closed.
        if status.as_ref().is_ok_and(|s| s.success()) {
            app.exit(0);
        }
        return;
    }
    let reason = match &status {
        Ok(status) => format!("Wim stopped ({status})."),
        Err(e) => format!("Wim stopped: {e}"),
    };
    let errors = errors.lock().unwrap();
    show_error(Some(&app), &format!("{reason}\n\n{}", String::from_utf8_lossy(&errors).trim()));
}

/// Show why Wim couldn't start in the window, which then stays until it's
/// closed.
fn show_error(app: Option<&AppHandle>, message: &str) {
    eprintln!("wim: {message}");
    if let Some(window) = app.and_then(|app| app.get_webview_window("main")) {
        let message = serde_json::to_string(message).unwrap();
        // The page may still be loading.
        let _ = window.eval(format!(
            "(function show() {{ if (window.showError) showError({message}); else setTimeout(show, 50); }})()"
        ));
    }
}

/// Whether the app was opened from the Finder, the Dock or a desktop
/// launcher rather than a terminal, so it lacks the environment (PATH and
/// the like) that the user's shell sets up.
fn launched_from_desktop() -> bool {
    cfg!(unix) && env::var_os("TERM").is_none()
}

/// The environment the user's shell sets up, as a terminal would have it:
/// Wim runs Node, language servers, git and a terminal from it.
fn login_shell_env() -> Option<Vec<(String, String)>> {
    const MARK: &str = "__WIM_ENV__";
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    // Interactive too, since version managers (nvm, fnm, ...) are often set
    // up in `.zshrc` or `.bashrc` rather than the login files.
    let mut child = Command::new(&shell)
        .args(["-i", "-l", "-c", &format!("printf {MARK}; /usr/bin/env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + SHELL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                eprintln!("wim: {shell} took too long to start; using the app's own environment");
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = String::from_utf8_lossy(&reader.join().ok()?).into_owned();
    let (_, vars) = out.split_once(MARK)?;
    let vars: Vec<(String, String)> = vars
        .split('\0')
        .filter_map(|var| var.split_once('='))
        .filter(|(k, _)| !matches!(*k, "_" | "PWD" | "OLDPWD" | "SHLVL"))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    vars.iter().any(|(k, _)| k == "PATH").then_some(vars)
}

/// Node: `WIM_NODE`, or `node` on the PATH.
fn find_node(path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(node) = env::var_os("WIM_NODE") {
        return Ok(node.into());
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let path = path.map(OsString::from).or_else(|| env::var_os("PATH")).unwrap_or_default();
    env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
        .ok_or_else(|| "Node.js wasn't found on the PATH; set WIM_NODE to it.".to_owned())
}

/// Wim's `wim.js`: in `WIM_HOME`, or the checkout this app was built from.
fn find_wim() -> Result<PathBuf, String> {
    let home = env::var_os("WIM_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
    let wim = home.join("wim.js");
    if wim.is_file() {
        Ok(wim)
    } else {
        Err(format!("Wim wasn't found at {}; set WIM_HOME to Wim's directory.", wim.display()))
    }
}
