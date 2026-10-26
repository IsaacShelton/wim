//! The editor core: modes, key dispatch, undo and dot-repeat. It knows
//! nothing about windows or rendering; the UI feeds it [`KeyInput`]s and reads
//! its state back.

pub mod buffer;
pub mod command;
mod ex;
pub mod keys;
mod motion;
mod ops;
pub mod registers;
pub mod search;
mod textobj;

use std::cell::RefCell;
use std::collections::HashMap;
use std::mem;
use std::path::{Path, PathBuf};

use regex::Regex;

use buffer::{Buffer, Pos};
use command::{Action, Command, FindKind, Parse};
use keys::{Key, KeyInput};
use registers::Registers;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Insert,
    Replace,
    Visual,
    VisualLine,
    CmdLine(CmdKind),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CmdKind {
    Ex,
    SearchForward,
    SearchBackward,
}

impl Mode {
    pub fn is_visual(self) -> bool {
        matches!(self, Mode::Visual | Mode::VisualLine)
    }

    pub fn is_insert(self) -> bool {
        matches!(self, Mode::Insert | Mode::Replace)
    }
}

#[derive(Clone, Debug)]
pub struct Options {
    pub number: bool,
    pub relativenumber: bool,
    pub ignorecase: bool,
    pub smartcase: bool,
    pub hlsearch: bool,
    pub incsearch: bool,
    pub expandtab: bool,
    pub autoindent: bool,
    pub tabstop: usize,
    pub shiftwidth: usize,
    pub scrolloff: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            number: true,
            relativenumber: false,
            ignorecase: false,
            smartcase: false,
            hlsearch: true,
            incsearch: true,
            expandtab: true,
            autoindent: true,
            tabstop: 4,
            shiftwidth: 4,
            scrolloff: 3,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Message {
    pub text: String,
    pub error: bool,
}

/// A visual selection, with an inclusive end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub start: Pos,
    pub end: Pos,
    pub linewise: bool,
}

struct Snapshot {
    lines: Vec<Vec<char>>,
    version: u64,
    cursor: Pos,
}

#[derive(Default)]
struct InsertSession {
    count: usize,
    /// For `o`/`O`: repeat by opening a new line each time.
    open_line: bool,
    typed: Vec<KeyInput>,
    /// A line holding only automatic indentation, removed if left empty.
    autoindent_line: Option<usize>,
}

#[derive(Clone)]
struct LastSearch {
    pattern: String,
    forward: bool,
}

struct LastVisual {
    mode: Mode,
    anchor: Pos,
    cursor: Pos,
}

pub struct Editor {
    pub(crate) buffer: Buffer,
    pub(crate) cursor: Pos,
    pub(crate) mode: Mode,
    pub(crate) options: Options,
    file_path: Option<PathBuf>,
    saved_version: u64,

    pub(crate) scroll_top: usize,
    pub(crate) scroll_left: usize,
    view_rows: usize,
    view_cols: usize,
    /// The column vertical motions try to keep (`usize::MAX` after `$`).
    want_col: usize,

    pending: Vec<KeyInput>,
    pub(crate) registers: Registers,
    undo_stack: Vec<Snapshot>,
    redo_stack: Vec<Snapshot>,
    undo_pending: Option<Snapshot>,

    last_change: Vec<KeyInput>,
    dot_record: Option<Vec<KeyInput>>,
    replaying: bool,
    insert: InsertSession,

    last_find: Option<(FindKind, char)>,
    last_search: Option<LastSearch>,
    last_substitute: Option<(String, String, String)>,
    hlsearch_active: bool,
    regex_cache: RefCell<Option<(String, bool, bool, Option<Regex>)>>,
    search_origin: Pos,

    visual_anchor: Pos,
    last_visual: Option<LastVisual>,
    marks: HashMap<char, Pos>,

    cmdline: String,
    ex_history: Vec<String>,
    search_history: Vec<String>,
    history_index: Option<usize>,

    message: Option<Message>,
    quit_requested: bool,
}

impl Default for Editor {
    fn default() -> Self {
        Self::new()
    }
}

impl Editor {
    pub fn new() -> Self {
        Self {
            buffer: Buffer::new(),
            cursor: Pos::default(),
            mode: Mode::Normal,
            options: Options::default(),
            file_path: None,
            saved_version: 0,
            scroll_top: 0,
            scroll_left: 0,
            view_rows: 40,
            view_cols: 120,
            want_col: 0,
            pending: Vec::new(),
            registers: Registers::default(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            undo_pending: None,
            last_change: Vec::new(),
            dot_record: None,
            replaying: false,
            insert: InsertSession::default(),
            last_find: None,
            last_search: None,
            last_substitute: None,
            hlsearch_active: false,
            regex_cache: RefCell::new(None),
            search_origin: Pos::default(),
            visual_anchor: Pos::default(),
            last_visual: None,
            marks: HashMap::new(),
            cmdline: String::new(),
            ex_history: Vec::new(),
            search_history: Vec::new(),
            history_index: None,
            message: None,
            quit_requested: false,
        }
    }

    #[cfg(test)]
    pub fn from_text(text: &str) -> Self {
        let mut ed = Self::new();
        ed.buffer = Buffer::from_text(text);
        ed.saved_version = ed.buffer.version();
        ed
    }

    // ----- Accessors used by the UI -------------------------------------

    pub fn buffer(&self) -> &Buffer {
        &self.buffer
    }

    pub fn cursor(&self) -> Pos {
        self.cursor
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn options(&self) -> &Options {
        &self.options
    }

    pub fn scroll_top(&self) -> usize {
        self.scroll_top
    }

    pub fn scroll_left(&self) -> usize {
        self.scroll_left
    }

    pub fn file_path(&self) -> Option<&Path> {
        self.file_path.as_deref()
    }

    pub fn file_name(&self) -> String {
        self.file_path
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "[No Name]".to_string())
    }

    pub fn is_modified(&self) -> bool {
        self.buffer.version() != self.saved_version
    }

    pub fn message(&self) -> Option<&Message> {
        self.message.as_ref()
    }

    pub fn set_message(&mut self, text: impl Into<String>) {
        self.message = Some(Message {
            text: text.into(),
            error: false,
        });
    }

    pub fn set_error(&mut self, text: impl Into<String>) {
        self.message = Some(Message {
            text: text.into(),
            error: true,
        });
    }

    pub fn quit_requested(&self) -> bool {
        self.quit_requested
    }

    pub fn mode_name(&self) -> &'static str {
        match self.mode {
            Mode::Normal => "NORMAL",
            Mode::Insert => "INSERT",
            Mode::Replace => "REPLACE",
            Mode::Visual => "VISUAL",
            Mode::VisualLine => "V-LINE",
            Mode::CmdLine(_) => "COMMAND",
        }
    }

    /// Keys typed so far for an incomplete command (Vim's `showcmd`).
    pub fn pending_keys(&self) -> String {
        self.pending.iter().map(|k| k.to_string()).collect()
    }

    /// The command line contents including its prompt, when active.
    pub fn cmdline(&self) -> Option<String> {
        let prompt = match self.mode {
            Mode::CmdLine(CmdKind::Ex) => ':',
            Mode::CmdLine(CmdKind::SearchForward) => '/',
            Mode::CmdLine(CmdKind::SearchBackward) => '?',
            _ => return None,
        };
        Some(format!("{prompt}{}", self.cmdline))
    }

    pub fn selection(&self) -> Option<Selection> {
        if !self.mode.is_visual() {
            return None;
        }
        let (start, end) = order(self.visual_anchor, self.cursor);
        Some(Selection {
            start,
            end,
            linewise: self.mode == Mode::VisualLine,
        })
    }

    /// The regex whose matches should be highlighted right now.
    pub fn highlight_regex(&self) -> Option<Regex> {
        match self.mode {
            Mode::CmdLine(CmdKind::SearchForward | CmdKind::SearchBackward)
                if self.options.incsearch =>
            {
                if self.cmdline.is_empty() {
                    None
                } else {
                    self.regex_for(&self.cmdline)
                }
            }
            _ if self.options.hlsearch && self.hlsearch_active => {
                let pattern = self.last_search.as_ref()?.pattern.clone();
                self.regex_for(&pattern)
            }
            _ => None,
        }
    }

    pub(crate) fn regex_for(&self, pattern: &str) -> Option<Regex> {
        let (ic, sc) = (self.options.ignorecase, self.options.smartcase);
        let mut cache = self.regex_cache.borrow_mut();
        if let Some((p, cached_ic, cached_sc, re)) = cache.as_ref()
            && p == pattern
            && *cached_ic == ic
            && *cached_sc == sc
        {
            return re.clone();
        }
        let re = search::compile(pattern, ic, sc).ok();
        *cache = Some((pattern.to_string(), ic, sc, re.clone()));
        re
    }

    // ----- Files ---------------------------------------------------------

    pub fn open_file(&mut self, path: &Path) {
        match std::fs::read(path) {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                self.load_text(&text);
                self.file_path = Some(path.to_path_buf());
                self.set_message(format!(
                    "\"{}\" {}L, {}B",
                    path.display(),
                    self.buffer.line_count(),
                    bytes.len()
                ));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.load_text("");
                self.file_path = Some(path.to_path_buf());
                self.set_message(format!("\"{}\" [New]", path.display()));
            }
            Err(e) => self.set_error(format!("E484: Can't open file {}: {e}", path.display())),
        }
    }

    fn load_text(&mut self, text: &str) {
        self.buffer = Buffer::from_text(text);
        self.saved_version = self.buffer.version();
        self.cursor = Pos::default();
        self.scroll_top = 0;
        self.scroll_left = 0;
        self.want_col = 0;
        self.mode = Mode::Normal;
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.undo_pending = None;
        self.marks.clear();
        self.last_visual = None;
    }

    pub(crate) fn write_file(&mut self, path: Option<PathBuf>) -> bool {
        let Some(path) = path.or_else(|| self.file_path.clone()) else {
            self.set_error("E32: No file name");
            return false;
        };
        let text = self.buffer.to_file_text();
        match std::fs::write(&path, &text) {
            Ok(()) => {
                if self.file_path.is_none() {
                    self.file_path = Some(path.clone());
                }
                if self.file_path.as_deref() == Some(path.as_path()) {
                    self.saved_version = self.buffer.version();
                }
                self.set_message(format!(
                    "\"{}\" {}L, {}B written",
                    path.display(),
                    self.buffer.line_count(),
                    text.len()
                ));
                true
            }
            Err(e) => {
                self.set_error(format!("E212: Can't open file for writing: {e}"));
                false
            }
        }
    }

    /// Request to close the window. Refuses (with a message) when there are
    /// unsaved changes unless `force` is set.
    pub fn request_quit(&mut self, force: bool) -> bool {
        if !force && self.is_modified() {
            self.set_error("E37: No write since last change (add ! to override)");
            return false;
        }
        self.quit_requested = true;
        true
    }

    // ----- Viewport --------------------------------------------------------

    pub fn set_viewport(&mut self, rows: usize, cols: usize) {
        self.view_rows = rows.max(1);
        self.view_cols = cols.max(1);
    }

    fn scrolloff(&self) -> usize {
        self.options
            .scrolloff
            .min(self.view_rows.saturating_sub(1) / 2)
    }

    pub fn scroll_to_cursor(&mut self) {
        let rows = self.view_rows;
        let so = self.scrolloff();
        let line = self.cursor.line;
        if line < self.scroll_top + so {
            self.scroll_top = line.saturating_sub(so);
        }
        if line + so >= self.scroll_top + rows {
            self.scroll_top = line + so + 1 - rows;
        }
        self.scroll_top = self.scroll_top.min(self.buffer.last_line());

        let dcol = self.display_col(line, self.cursor.col);
        if dcol < self.scroll_left {
            self.scroll_left = dcol;
        }
        if dcol >= self.scroll_left + self.view_cols {
            self.scroll_left = dcol + 1 - self.view_cols;
        }
    }

    /// Scroll the view (mouse wheel, `<C-e>`, `<C-y>`) and keep the cursor
    /// inside it.
    pub fn scroll_by(&mut self, delta: isize) {
        let last = self.buffer.last_line();
        self.scroll_top = self.scroll_top.saturating_add_signed(delta).min(last);
        let so = self.scrolloff();
        let top = if self.scroll_top == 0 {
            0
        } else {
            self.scroll_top + so
        };
        let bottom = (self.scroll_top + self.view_rows)
            .saturating_sub(1 + so)
            .max(top);
        let line = self.cursor.line.clamp(top.min(last), bottom.min(last));
        if line != self.cursor.line {
            self.cursor.line = line;
            self.cursor.col = self.col_for_want(line);
        }
    }

    pub fn display_col(&self, line: usize, col: usize) -> usize {
        let ts = self.options.tabstop.max(1);
        let mut d = 0;
        for &c in self.buffer.line(line).iter().take(col) {
            d = if c == '\t' { (d / ts + 1) * ts } else { d + 1 };
        }
        let len = self.buffer.line_len(line);
        d + col.saturating_sub(len)
    }

    pub fn col_from_display(&self, line: usize, dcol: usize) -> usize {
        let ts = self.options.tabstop.max(1);
        let mut d = 0;
        for (i, &c) in self.buffer.line(line).iter().enumerate() {
            let next = if c == '\t' { (d / ts + 1) * ts } else { d + 1 };
            if dcol < next {
                return i;
            }
            d = next;
        }
        self.buffer.line_len(line)
    }

    // ----- Mouse -----------------------------------------------------------

    pub fn click(&mut self, pos: Pos) {
        if matches!(self.mode, Mode::CmdLine(_)) {
            return;
        }
        if self.mode.is_visual() {
            self.exit_visual();
        }
        self.pending.clear();
        self.cursor = pos;
        self.clamp_cursor();
        self.update_want_col();
    }

    pub fn drag_to(&mut self, pos: Pos) {
        if self.mode == Mode::Normal {
            self.visual_anchor = self.cursor;
            self.mode = Mode::Visual;
        }
        if self.mode.is_visual() {
            self.cursor = pos;
            self.clamp_cursor();
            self.update_want_col();
        }
    }

    // ----- Paste from the OS (Cmd+V) ----------------------------------------

    pub fn paste_text(&mut self, text: &str) {
        let text = text.replace("\r\n", "\n");
        match self.mode {
            Mode::Insert | Mode::Replace => {
                self.cursor = self.buffer.insert_text(self.cursor, &text);
            }
            Mode::CmdLine(_) => self.cmdline.push_str(text.lines().next().unwrap_or("")),
            _ => {}
        }
    }

    /// Copy (or cut) the visual selection to the system clipboard (Cmd+C/X).
    pub fn copy_selection(&mut self, cut: bool) {
        if !self.mode.is_visual() {
            return;
        }
        let op = if cut {
            command::Operator::Delete
        } else {
            command::Operator::Yank
        };
        self.undo_pending = Some(self.snapshot());
        self.visual_operate(op, false, 1, Some('+'));
        self.commit_undo();
        self.clamp_cursor();
    }

    // ----- Key handling ----------------------------------------------------

    pub fn handle_key(&mut self, key: KeyInput) {
        if !self.replaying {
            self.message = None;
        }
        match self.mode {
            Mode::Normal | Mode::Visual | Mode::VisualLine => self.normal_key(key),
            Mode::Insert | Mode::Replace => self.insert_key(key),
            Mode::CmdLine(kind) => self.cmdline_key(key, kind),
        }
        self.scroll_to_cursor();
    }

    pub fn handle_keys(&mut self, keys: &[KeyInput]) {
        for &k in keys {
            self.handle_key(k);
        }
    }

    fn normal_key(&mut self, key: KeyInput) {
        if key.key == Key::Esc {
            if self.pending.is_empty() && self.mode.is_visual() {
                self.exit_visual();
            }
            self.pending.clear();
            return;
        }
        self.pending.push(key);
        match command::parse(&self.pending, self.mode.is_visual()) {
            Parse::Incomplete => {}
            Parse::Invalid => self.pending.clear(),
            Parse::Done(cmd) => {
                let keys = mem::take(&mut self.pending);
                self.run_command(cmd, keys);
            }
        }
    }

    fn run_command(&mut self, cmd: Command, keys: Vec<KeyInput>) {
        let may_change = may_change(&cmd.action);
        let from_visual = self.mode.is_visual();
        let version = self.buffer.version();
        if may_change && self.undo_pending.is_none() {
            self.undo_pending = Some(self.snapshot());
        }
        self.execute(cmd);
        if self.mode.is_insert() {
            if may_change && !from_visual && !self.replaying {
                self.dot_record = Some(keys);
            }
        } else {
            if self.buffer.version() != version && !from_visual && !self.replaying {
                self.last_change = keys;
            }
            self.commit_undo();
        }
        if !self.mode.is_insert() && !matches!(self.mode, Mode::CmdLine(_)) {
            self.clamp_cursor();
        }
    }

    fn execute(&mut self, cmd: Command) {
        let count = cmd.count.unwrap_or(1);
        match cmd.action {
            Action::Move(m) => {
                if let Some(target) = self.eval_motion(m, cmd.count, false) {
                    self.move_to(m, target);
                }
            }
            Action::Operate(op, target) => self.operate(op, target, cmd.count, cmd.register),
            Action::Insert(kind) => self.start_insert(kind, count),
            Action::Paste { before } => self.paste(cmd.register, before, count),
            Action::ReplaceChar(c) => self.replace_chars(c, count),
            Action::Join { spaces } => match self.selection() {
                Some(sel) => {
                    self.exit_visual();
                    self.join_lines(
                        sel.start.line,
                        (sel.end.line - sel.start.line).max(1),
                        spaces,
                    );
                }
                None => self.join_lines(self.cursor.line, count.max(2) - 1, spaces),
            },
            Action::Undo => {
                for _ in 0..count {
                    self.undo();
                }
            }
            Action::Redo => {
                for _ in 0..count {
                    self.redo();
                }
            }
            Action::Repeat => self.repeat_last_change(cmd.count),
            Action::ToggleCaseChar => self.toggle_case_chars(count),
            Action::Visual | Action::VisualLine => {
                let target = if cmd.action == Action::Visual {
                    Mode::Visual
                } else {
                    Mode::VisualLine
                };
                if self.mode == target {
                    self.exit_visual();
                } else {
                    if !self.mode.is_visual() {
                        self.visual_anchor = self.cursor;
                    }
                    self.mode = target;
                }
            }
            Action::Reselect => {
                if let Some(v) = &self.last_visual {
                    self.mode = v.mode;
                    self.visual_anchor = v.anchor;
                    self.cursor = v.cursor;
                    self.clamp_pos_visual();
                }
            }
            Action::ReplaceMode => {
                self.mode = Mode::Replace;
                self.insert = InsertSession {
                    count: 1,
                    ..Default::default()
                };
            }
            Action::CmdLine => {
                self.cmdline = if self.mode.is_visual() {
                    self.exit_visual();
                    "'<,'>".to_string()
                } else if count > 1 {
                    format!(".,.+{}", count - 1)
                } else {
                    String::new()
                };
                self.history_index = None;
                self.mode = Mode::CmdLine(CmdKind::Ex);
            }
            Action::Search { forward } => {
                if self.mode.is_visual() {
                    self.exit_visual();
                }
                self.cmdline.clear();
                self.history_index = None;
                self.search_origin = self.cursor;
                self.mode = Mode::CmdLine(if forward {
                    CmdKind::SearchForward
                } else {
                    CmdKind::SearchBackward
                });
            }
            Action::SearchWord { forward } => self.search_word(forward, count),
            Action::Scroll(s) => self.scroll(s, cmd.count),
            Action::SetMark(c) => {
                self.marks.insert(c, self.cursor);
            }
            Action::Increment(sign) => self.increment(sign * count as i64),
            Action::WriteQuit => {
                if !self.is_modified() || self.write_file(None) {
                    self.quit_requested = true;
                }
            }
            Action::QuitForce => self.quit_requested = true,
            Action::FileInfo => self.show_file_info(),
            Action::VisualOp(op) => self.visual_operate(op, false, count, cmd.register),
            Action::VisualLinewiseOp(op) => self.visual_operate(op, true, count, cmd.register),
            Action::VisualObject { obj, around } => self.visual_select_object(obj, around, count),
            Action::VisualSwap => mem::swap(&mut self.visual_anchor, &mut self.cursor),
            Action::VisualReplace(c) => self.visual_replace(c),
            Action::VisualPaste => self.visual_paste(cmd.register),
        }
    }

    // ----- Insert & Replace mode ---------------------------------------------

    fn insert_key(&mut self, key: KeyInput) {
        if key.key == Key::Esc {
            self.finish_insert();
            return;
        }
        if let Some(rec) = &mut self.dot_record {
            rec.push(key);
        }
        self.insert.typed.push(key);
        self.apply_insert_key(key);
    }

    pub(crate) fn begin_insert(&mut self, count: usize, open_line: bool) {
        self.mode = Mode::Insert;
        self.insert = InsertSession {
            count,
            open_line,
            ..Default::default()
        };
    }

    fn finish_insert(&mut self) {
        let session = mem::take(&mut self.insert);
        for _ in 1..session.count {
            if session.open_line {
                self.open_line(true);
            }
            for &k in &session.typed {
                self.apply_insert_key(k);
            }
        }
        // After repeats the replayed keys decide; otherwise the session does.
        let repeated = mem::take(&mut self.insert);
        let autoindent_line = if session.count > 1 {
            repeated.autoindent_line
        } else {
            session.autoindent_line
        };
        if let Some(line) = autoindent_line
            && line == self.cursor.line
            && line < self.buffer.line_count()
            && self.buffer.is_blank_line(line)
        {
            self.buffer.replace_line(line, Vec::new());
            self.cursor.col = 0;
        }
        if let Some(mut rec) = self.dot_record.take() {
            rec.push(KeyInput::plain(Key::Esc));
            self.last_change = rec;
        }
        self.mode = Mode::Normal;
        self.marks.insert('^', self.cursor);
        self.cursor.col = self.cursor.col.saturating_sub(1);
        self.clamp_cursor();
        self.update_want_col();
        self.commit_undo();
    }

    fn apply_insert_key(&mut self, key: KeyInput) {
        let replace = self.mode == Mode::Replace;
        let cur = self.cursor;
        let len = self.buffer.line_len(cur.line);
        if key.ctrl {
            match key.key {
                Key::Char('w') => self.insert_delete_word(),
                Key::Char('u') => {
                    let indent = self.buffer.indent_of(cur.line).len();
                    let start = if cur.col > indent { indent } else { 0 };
                    self.buffer.delete_range(Pos::new(cur.line, start), cur);
                    self.cursor.col = start;
                }
                Key::Char('t') | Key::Char('d') => {
                    let before = self.buffer.line_len(cur.line);
                    self.shift_lines(cur.line, cur.line, key.key == Key::Char('t'));
                    let after = self.buffer.line_len(cur.line);
                    self.cursor.col = (cur.col + after).saturating_sub(before);
                }
                _ => {}
            }
            return;
        }
        match key.key {
            Key::Char(c) if replace => {
                if cur.col < len {
                    self.buffer.set_char(cur, c);
                } else {
                    self.buffer.insert_char(cur, c);
                }
                self.cursor.col += 1;
            }
            Key::Char(c) => self.insert_char(c),
            Key::Enter => self.insert_newline(),
            Key::Tab => {
                if self.options.expandtab {
                    let sw = self.options.shiftwidth.max(1);
                    let n = sw - self.display_col(cur.line, cur.col) % sw;
                    self.cursor = self.buffer.insert_text(cur, &" ".repeat(n));
                } else {
                    self.buffer.insert_char(cur, '\t');
                    self.cursor.col += 1;
                }
            }
            Key::Backspace if replace => {
                if cur.col > 0 {
                    self.cursor.col -= 1;
                }
            }
            Key::Backspace => self.insert_backspace(),
            Key::Delete => {
                if cur.col < len {
                    self.buffer
                        .delete_range(cur, Pos::new(cur.line, cur.col + 1));
                } else if cur.line < self.buffer.last_line() {
                    self.buffer.delete_range(cur, Pos::new(cur.line + 1, 0));
                }
            }
            Key::Left => self.cursor.col = cur.col.saturating_sub(1),
            Key::Right => self.cursor.col = (cur.col + 1).min(len),
            Key::Home => self.cursor.col = 0,
            Key::End => self.cursor.col = len,
            Key::Up | Key::Down | Key::PageUp | Key::PageDown => {
                let rows = if matches!(key.key, Key::PageUp | Key::PageDown) {
                    self.view_rows
                } else {
                    1
                };
                let line = if matches!(key.key, Key::Up | Key::PageUp) {
                    cur.line.saturating_sub(rows)
                } else {
                    (cur.line + rows).min(self.buffer.last_line())
                };
                // Keep the remembered column across consecutive vertical moves.
                self.cursor = Pos::new(line, self.col_for_want(line));
                return;
            }
            Key::Esc => {}
        }
        self.update_want_col();
    }

    fn insert_char(&mut self, c: char) {
        let cur = self.cursor;
        let sw = self.options.shiftwidth.max(1);
        // Typing a closing brace on a line of pure indentation dedents it.
        if c == '}'
            && cur.col > 0
            && self.buffer.line(cur.line)[..cur.col]
                .iter()
                .all(|&c| c == ' ')
        {
            let remove = cur.col.min(sw);
            self.buffer
                .delete_range(Pos::new(cur.line, 0), Pos::new(cur.line, remove));
            self.cursor.col -= remove;
        }
        self.buffer.insert_char(self.cursor, c);
        self.cursor.col += 1;
        self.insert.autoindent_line = None;
    }

    fn insert_newline(&mut self) {
        let cur = self.cursor;
        let line = self.buffer.line(cur.line);
        let mut indent: Vec<char> = if self.options.autoindent {
            line.iter()
                .take(cur.col)
                .take_while(|c| **c == ' ' || **c == '\t')
                .copied()
                .collect()
        } else {
            Vec::new()
        };
        let before = line[..cur.col]
            .iter()
            .rev()
            .find(|c| !c.is_whitespace())
            .copied();
        let after = line.get(cur.col).copied();
        let opens = matches!(before, Some('{' | '(' | '['));
        let closes_pair = matches!(
            (before, after),
            (Some('{'), Some('}')) | (Some('('), Some(')')) | (Some('['), Some(']'))
        );

        // A line that only held automatic indentation is cleared.
        if self.insert.autoindent_line == Some(cur.line) && self.buffer.is_blank_line(cur.line) {
            self.buffer.replace_line(cur.line, Vec::new());
            self.cursor.col = 0;
        }
        let outer: String = indent.iter().collect();
        if opens && self.options.autoindent {
            indent.extend(self.indent_unit());
        }
        let text = format!("\n{}", indent.iter().collect::<String>());
        self.cursor = self.buffer.insert_text(self.cursor, &text);
        if closes_pair {
            self.buffer.insert_text(self.cursor, &format!("\n{outer}"));
        }
        self.insert.autoindent_line = (!indent.is_empty()).then_some(self.cursor.line);
    }

    fn insert_backspace(&mut self) {
        let cur = self.cursor;
        if cur.col == 0 {
            if cur.line > 0 {
                let prev = Pos::new(cur.line - 1, self.buffer.line_len(cur.line - 1));
                self.buffer.delete_range(prev, cur);
                self.cursor = prev;
            }
            return;
        }
        let line = self.buffer.line(cur.line);
        let sw = self.options.shiftwidth.max(1);
        let n = if self.options.expandtab && line[..cur.col].iter().all(|&c| c == ' ') {
            (cur.col - 1) % sw + 1
        } else {
            1
        };
        self.buffer
            .delete_range(Pos::new(cur.line, cur.col - n), cur);
        self.cursor.col -= n;
    }

    fn insert_delete_word(&mut self) {
        let cur = self.cursor;
        if cur.col == 0 {
            self.insert_backspace();
            return;
        }
        let start = motion::prev_word_start(&self.buffer, cur, false);
        let start = if start.line == cur.line {
            start
        } else {
            Pos::new(cur.line, 0)
        };
        self.buffer.delete_range(start, cur);
        self.cursor = start;
    }

    pub(crate) fn indent_unit(&self) -> Vec<char> {
        if self.options.expandtab {
            vec![' '; self.options.shiftwidth.max(1)]
        } else {
            vec!['\t']
        }
    }

    // ----- Command line ------------------------------------------------------

    fn cmdline_key(&mut self, key: KeyInput, kind: CmdKind) {
        let search = kind != CmdKind::Ex;
        match key.key {
            Key::Esc => {
                self.cancel_cmdline(search);
                return;
            }
            Key::Enter => {
                let line = mem::take(&mut self.cmdline);
                self.mode = Mode::Normal;
                if search {
                    push_history(&mut self.search_history, &line);
                    self.submit_search(line, kind == CmdKind::SearchForward);
                } else {
                    push_history(&mut self.ex_history, &line);
                    self.run_ex(&line);
                }
                return;
            }
            Key::Backspace => {
                if self.cmdline.pop().is_none() {
                    self.cancel_cmdline(search);
                    return;
                }
            }
            Key::Up | Key::Down => {
                let history = if search {
                    &self.search_history
                } else {
                    &self.ex_history
                };
                if !history.is_empty() {
                    let idx = match (self.history_index, key.key == Key::Up) {
                        (None, true) => Some(history.len() - 1),
                        (None, false) => None,
                        (Some(i), true) => Some(i.saturating_sub(1)),
                        (Some(i), false) => (i + 1 < history.len()).then_some(i + 1),
                    };
                    self.cmdline = idx.map(|i| history[i].clone()).unwrap_or_default();
                    self.history_index = idx;
                }
            }
            Key::Tab => self.complete_cmdline(),
            Key::Char('u') if key.ctrl => self.cmdline.clear(),
            Key::Char('w') if key.ctrl => {
                let trimmed = self.cmdline.trim_end_matches(' ');
                let keep = trimmed
                    .trim_end_matches(|c: char| c.is_alphanumeric() || c == '_')
                    .len();
                let keep = if keep == trimmed.len() {
                    trimmed.len().saturating_sub(1)
                } else {
                    keep
                };
                self.cmdline.truncate(keep);
            }
            Key::Char(c) if !key.ctrl => self.cmdline.push(c),
            _ => {}
        }
        if search && self.options.incsearch {
            self.cursor = self.search_origin;
            if let Some(re) = self.regex_for(&self.cmdline.clone())
                && let Some((pos, _)) = search::find(
                    &self.buffer,
                    &re,
                    self.search_origin,
                    kind == CmdKind::SearchForward,
                )
            {
                self.cursor = pos;
            }
        }
    }

    fn cancel_cmdline(&mut self, search: bool) {
        self.cmdline.clear();
        self.mode = Mode::Normal;
        if search {
            self.cursor = self.search_origin;
        }
    }

    /// Complete a file name argument for `:e`/`:w`.
    fn complete_cmdline(&mut self) {
        let Some((cmd, arg)) = self.cmdline.split_once(' ') else {
            return;
        };
        if !matches!(cmd, "e" | "edit" | "w" | "write" | "sp" | "r") {
            return;
        }
        let path = expand_tilde(arg);
        let (dir, prefix) = match path.rfind('/') {
            Some(i) => (path[..=i].to_string(), path[i + 1..].to_string()),
            None => (String::new(), path.clone()),
        };
        let read_dir = if dir.is_empty() { "." } else { dir.as_str() };
        let Ok(entries) = std::fs::read_dir(read_dir) else {
            return;
        };
        let mut matches: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                name.starts_with(&prefix)
                    .then(|| if is_dir { format!("{name}/") } else { name })
            })
            .collect();
        matches.sort();
        let Some(first) = matches.first() else {
            return;
        };
        let common = matches.iter().fold(first.clone(), |acc, m| {
            acc.chars()
                .zip(m.chars())
                .take_while(|(a, b)| a == b)
                .map(|(a, _)| a)
                .collect()
        });
        self.cmdline = format!("{cmd} {dir}{common}");
        if matches.len() > 1 {
            self.set_message(matches.join("  "));
        }
    }

    fn submit_search(&mut self, pattern: String, forward: bool) {
        self.cursor = self.search_origin;
        let pattern = if pattern.is_empty() {
            match &self.last_search {
                Some(s) => s.pattern.clone(),
                None => {
                    self.set_error("E35: No previous regular expression");
                    return;
                }
            }
        } else {
            pattern
        };
        self.last_search = Some(LastSearch { pattern, forward });
        if let Some(target) = self.eval_motion(command::Motion::SearchNext, None, false) {
            self.move_to(command::Motion::SearchNext, target);
        }
    }

    // ----- Undo ------------------------------------------------------------

    fn snapshot(&self) -> Snapshot {
        let (lines, version) = self.buffer.snapshot();
        Snapshot {
            lines,
            version,
            cursor: self.cursor,
        }
    }

    fn commit_undo(&mut self) {
        if let Some(s) = self.undo_pending.take()
            && s.version != self.buffer.version()
        {
            self.undo_stack.push(s);
            self.redo_stack.clear();
        }
    }

    fn restore(&mut self, s: Snapshot) {
        self.buffer.restore(s.lines, s.version);
        self.cursor = s.cursor;
        self.clamp_cursor();
        self.update_want_col();
    }

    fn undo(&mut self) {
        match self.undo_stack.pop() {
            Some(s) => {
                let current = self.snapshot();
                self.redo_stack.push(Snapshot {
                    cursor: s.cursor,
                    ..current
                });
                self.restore(s);
            }
            None => self.set_message("Already at oldest change"),
        }
    }

    fn redo(&mut self) {
        match self.redo_stack.pop() {
            Some(s) => {
                let current = self.snapshot();
                self.undo_stack.push(Snapshot {
                    cursor: s.cursor,
                    ..current
                });
                self.restore(s);
            }
            None => self.set_message("Already at newest change"),
        }
    }

    // ----- Dot repeat --------------------------------------------------------

    fn repeat_last_change(&mut self, count: Option<usize>) {
        if self.last_change.is_empty() || self.replaying {
            return;
        }
        let mut keys = self.last_change.clone();
        if let Some(n) = count {
            // A count given to `.` replaces the original count.
            let mut i = 0;
            if keys.first().is_some_and(|k| k.is('"')) {
                i = 2;
            }
            let digits = keys[i.min(keys.len())..]
                .iter()
                .take_while(|k| k.char().is_some_and(|c| c.is_ascii_digit()))
                .count();
            keys.splice(i..i + digits, n.to_string().chars().map(KeyInput::ch));
        }
        self.replaying = true;
        for k in keys {
            self.handle_key(k);
        }
        self.replaying = false;
    }

    // ----- Visual mode helpers -------------------------------------------------

    pub(crate) fn exit_visual(&mut self) {
        if !self.mode.is_visual() {
            return;
        }
        let (start, end) = order(self.visual_anchor, self.cursor);
        self.marks.insert('<', start);
        self.marks.insert('>', end);
        self.last_visual = Some(LastVisual {
            mode: self.mode,
            anchor: self.visual_anchor,
            cursor: self.cursor,
        });
        self.mode = Mode::Normal;
    }

    fn clamp_pos_visual(&mut self) {
        let last = self.buffer.last_line();
        for p in [&mut self.visual_anchor, &mut self.cursor] {
            p.line = p.line.min(last);
            p.col = p.col.min(self.buffer.line_len(p.line).saturating_sub(1));
        }
    }

    // ----- Cursor helpers ------------------------------------------------------

    pub(crate) fn clamp_cursor(&mut self) {
        let last = self.buffer.last_line();
        self.cursor.line = self.cursor.line.min(last);
        let len = self.buffer.line_len(self.cursor.line);
        let max = if self.mode.is_insert() {
            len
        } else {
            len.saturating_sub(1)
        };
        self.cursor.col = self.cursor.col.min(max);
    }

    /// Remember the cursor's display column for later vertical motions.
    pub(crate) fn update_want_col(&mut self) {
        self.want_col = self.display_col(self.cursor.line, self.cursor.col);
    }

    /// The column on `line` closest to the remembered display column.
    pub(crate) fn col_for_want(&self, line: usize) -> usize {
        let len = self.buffer.line_len(line);
        let max = if self.mode.is_insert() {
            len
        } else {
            len.saturating_sub(1)
        };
        if self.want_col == usize::MAX {
            return max;
        }
        self.col_from_display(line, self.want_col).min(max)
    }

    fn show_file_info(&mut self) {
        let lines = self.buffer.line_count();
        let pct = (self.cursor.line + 1) * 100 / lines;
        let modified = if self.is_modified() {
            " [Modified]"
        } else {
            ""
        };
        self.set_message(format!(
            "\"{}\"{modified} {lines} lines --{pct}%--",
            self.file_name()
        ));
    }
}

fn may_change(action: &Action) -> bool {
    use command::Operator;
    match action {
        Action::Operate(op, _) | Action::VisualOp(op) | Action::VisualLinewiseOp(op) => {
            *op != Operator::Yank
        }
        Action::Insert(_)
        | Action::Paste { .. }
        | Action::ReplaceChar(_)
        | Action::Join { .. }
        | Action::ToggleCaseChar
        | Action::ReplaceMode
        | Action::Increment(_)
        | Action::VisualReplace(_)
        | Action::VisualPaste => true,
        _ => false,
    }
}

pub(crate) fn order(a: Pos, b: Pos) -> (Pos, Pos) {
    if a <= b { (a, b) } else { (b, a) }
}

fn push_history(history: &mut Vec<String>, line: &str) {
    if line.is_empty() {
        return;
    }
    history.retain(|h| h != line);
    history.push(line.to_string());
}

pub(crate) fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix('~')
        && let Some(home) = std::env::var_os("HOME")
    {
        return format!("{}{rest}", home.to_string_lossy());
    }
    path.to_string()
}

#[cfg(test)]
mod tests;
