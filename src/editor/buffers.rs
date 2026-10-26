//! Multiple buffers and file I/O.
//!
//! The active buffer's state lives directly in [`Editor`]'s fields, so motions
//! and operators never need to know about buffers. Every buffer also has a
//! [`BufferSlot`]; switching swaps the active state into its slot and the
//! target slot's state out of it.

use std::collections::HashMap;
use std::mem;
use std::path::{Path, PathBuf};

use super::buffer::{Buffer, Pos};
use super::{Editor, LastVisual, Mode, Snapshot};

pub(crate) struct BufferSlot {
    id: usize,
    buffer: Buffer,
    cursor: Pos,
    file_path: Option<PathBuf>,
    saved_version: u64,
    scroll_top: usize,
    scroll_left: usize,
    want_col: usize,
    undo_stack: Vec<Snapshot>,
    redo_stack: Vec<Snapshot>,
    marks: HashMap<char, Pos>,
    last_visual: Option<LastVisual>,
}

impl BufferSlot {
    pub(crate) fn new(id: usize) -> Self {
        Self {
            id,
            buffer: Buffer::new(),
            cursor: Pos::default(),
            file_path: None,
            saved_version: 0,
            scroll_top: 0,
            scroll_left: 0,
            want_col: 0,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            marks: HashMap::new(),
            last_visual: None,
        }
    }

    fn is_modified(&self) -> bool {
        self.buffer.version() != self.saved_version
    }
}

/// A buffer as listed in the tab line and by `:ls`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BufferInfo {
    pub id: usize,
    pub name: String,
    pub modified: bool,
    pub active: bool,
}

impl Editor {
    fn swap_slot(&mut self, i: usize) {
        let s = &mut self.buffers[i];
        mem::swap(&mut self.buffer, &mut s.buffer);
        mem::swap(&mut self.cursor, &mut s.cursor);
        mem::swap(&mut self.file_path, &mut s.file_path);
        mem::swap(&mut self.saved_version, &mut s.saved_version);
        mem::swap(&mut self.scroll_top, &mut s.scroll_top);
        mem::swap(&mut self.scroll_left, &mut s.scroll_left);
        mem::swap(&mut self.want_col, &mut s.want_col);
        mem::swap(&mut self.undo_stack, &mut s.undo_stack);
        mem::swap(&mut self.redo_stack, &mut s.redo_stack);
        mem::swap(&mut self.marks, &mut s.marks);
        mem::swap(&mut self.last_visual, &mut s.last_visual);
    }

    /// The id of the active buffer (as shown by `:ls`).
    pub fn buffer_id(&self) -> usize {
        self.buffers[self.current].id
    }

    pub fn buffer_list(&self) -> Vec<BufferInfo> {
        self.buffers
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let active = i == self.current;
                BufferInfo {
                    id: s.id,
                    name: if active {
                        self.file_name()
                    } else {
                        display_name(s.file_path.as_deref())
                    },
                    modified: if active {
                        self.is_modified()
                    } else {
                        s.is_modified()
                    },
                    active,
                }
            })
            .collect()
    }

    /// Switch to buffer `id` if it is still open.
    pub(crate) fn switch_to_buffer_quietly(&mut self, id: usize) -> bool {
        match self.buffers.iter().position(|s| s.id == id) {
            Some(i) => {
                self.activate(i);
                true
            }
            None => false,
        }
    }

    pub fn switch_to_buffer(&mut self, id: usize) -> bool {
        match self.buffers.iter().position(|s| s.id == id) {
            Some(i) => {
                self.activate(i);
                true
            }
            None => {
                self.set_error(format!("E86: Buffer {id} does not exist"));
                false
            }
        }
    }

    fn activate(&mut self, i: usize) {
        if i == self.current {
            return;
        }
        if self.mode.is_visual() {
            self.exit_visual();
        }
        self.mode = Mode::Normal;
        self.pending.clear();
        self.commit_undo();
        self.alternate = Some(self.buffer_id());
        self.swap_slot(self.current);
        self.swap_slot(i);
        self.current = i;
        self.yank_flash = None;
        self.clamp_cursor();
    }

    pub(crate) fn new_buffer(&mut self) {
        let id = self.next_buffer_id;
        self.next_buffer_id += 1;
        self.buffers.push(BufferSlot::new(id));
        self.activate(self.buffers.len() - 1);
    }

    pub(crate) fn cycle_buffer(&mut self, delta: isize) {
        let n = self.buffers.len() as isize;
        self.activate((self.current as isize + delta).rem_euclid(n) as usize);
    }

    pub(crate) fn first_or_last_buffer(&mut self, last: bool) {
        self.activate(if last { self.buffers.len() - 1 } else { 0 });
    }

    pub(crate) fn alternate_buffer(&mut self) {
        match self.alternate {
            Some(id) => {
                self.switch_to_buffer(id);
            }
            None => self.set_error("E23: No alternate file"),
        }
    }

    /// Switch to the buffer whose name matches `query` (`:b name`).
    pub(crate) fn switch_by_name(&mut self, query: &str) -> Result<(), String> {
        let list = self.buffer_list();
        let exact: Vec<_> = list.iter().filter(|b| b.name == query).collect();
        let matches: Vec<_> = if exact.is_empty() {
            list.iter().filter(|b| b.name.contains(query)).collect()
        } else {
            exact
        };
        match matches.as_slice() {
            [one] => {
                self.switch_to_buffer(one.id);
                Ok(())
            }
            [] => Err(format!("E94: No matching buffer for {query}")),
            _ => Err(format!("E93: More than one match for {query}")),
        }
    }

    /// Open `path`, reusing a buffer that already shows it. An empty,
    /// unnamed, unmodified buffer is replaced rather than kept around.
    pub fn open_file(&mut self, path: &Path) {
        let path = absolute(path);
        let existing = (0..self.buffers.len()).find(|&i| {
            let p = if i == self.current {
                &self.file_path
            } else {
                &self.buffers[i].file_path
            };
            p.as_deref() == Some(path.as_path())
        });
        if let Some(i) = existing {
            self.activate(i);
            return;
        }
        let reusable = self.file_path.is_none()
            && !self.is_modified()
            && self.buffer.line_count() == 1
            && self.buffer.line_len(0) == 0;
        if !reusable {
            self.new_buffer();
        }
        self.load_file(&path);
    }

    /// (Re)load the active buffer from `path`.
    pub(crate) fn load_file(&mut self, path: &Path) {
        let name = display_name(Some(path));
        match std::fs::read(path) {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                self.load_text(&text);
                self.file_path = Some(path.to_path_buf());
                self.set_message(format!(
                    "\"{name}\" {}L, {}B",
                    self.buffer.line_count(),
                    bytes.len()
                ));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.load_text("");
                self.file_path = Some(path.to_path_buf());
                self.set_message(format!("\"{name}\" [New]"));
            }
            Err(e) => self.set_error(format!("E484: Can't open file {name}: {e}")),
        }
    }

    pub(crate) fn load_text(&mut self, text: &str) {
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
        let Some(path) = path
            .map(|p| absolute(&p))
            .or_else(|| self.file_path.clone())
        else {
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
                    display_name(Some(&path)),
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

    /// Write every modified buffer (`:wa`).
    pub(crate) fn write_all(&mut self) -> bool {
        let mut ok = !self.is_modified() || self.write_file(None);
        for i in 0..self.buffers.len() {
            if i == self.current || !self.buffers[i].is_modified() {
                continue;
            }
            let slot = &mut self.buffers[i];
            let Some(path) = slot.file_path.clone() else {
                let id = slot.id;
                self.set_error(format!("E141: No file name for buffer {id}"));
                ok = false;
                continue;
            };
            match std::fs::write(&path, slot.buffer.to_file_text()) {
                Ok(()) => slot.saved_version = slot.buffer.version(),
                Err(e) => {
                    self.set_error(format!("E212: Can't open file for writing: {e}"));
                    ok = false;
                }
            }
        }
        ok
    }

    /// The first buffer with unsaved changes, active buffer first.
    pub fn first_modified_buffer(&self) -> Option<BufferInfo> {
        let list = self.buffer_list();
        list.iter()
            .find(|b| b.active && b.modified)
            .or_else(|| list.iter().find(|b| b.modified))
            .cloned()
    }

    /// Close every buffer (`:%bd`), or every other one (`:bonly`).
    pub(crate) fn delete_all_buffers(
        &mut self,
        force: bool,
        keep_current: bool,
    ) -> Result<(), String> {
        let current = self.buffer_id();
        let ids: Vec<usize> = self
            .buffers
            .iter()
            .map(|s| s.id)
            .filter(|&id| !keep_current || id != current)
            .collect();
        let mut result = Ok(());
        for id in ids {
            if let Err(e) = self.delete_buffer(Some(id), force) {
                result = Err(e);
            }
        }
        result
    }

    /// Close a buffer (`:bd`); the active one when `id` is `None`.
    pub(crate) fn delete_buffer(&mut self, id: Option<usize>, force: bool) -> Result<(), String> {
        let i = match id {
            Some(id) => self
                .buffers
                .iter()
                .position(|s| s.id == id)
                .ok_or(format!("E516: No buffers were deleted: {id}"))?,
            None => self.current,
        };
        let id = self.buffers[i].id;
        let modified = if i == self.current {
            self.is_modified()
        } else {
            self.buffers[i].is_modified()
        };
        if modified && !force {
            return Err(format!(
                "E89: No write since last change for buffer {id} (add ! to override)"
            ));
        }
        if self.buffers.len() == 1 {
            self.load_text("");
            self.file_path = None;
            return Ok(());
        }
        if i == self.current {
            let alternate = self
                .alternate
                .and_then(|alt| self.buffers.iter().position(|s| s.id == alt))
                .filter(|&j| j != i);
            let neighbor = if i + 1 < self.buffers.len() {
                i + 1
            } else {
                i - 1
            };
            self.activate(alternate.unwrap_or(neighbor));
        }
        self.buffers.remove(i);
        if i < self.current {
            self.current -= 1;
        }
        if self.alternate == Some(id) {
            self.alternate = None;
        }
        Ok(())
    }
}

/// An absolute, canonical form of `path` so the same file is never opened in
/// two buffers.
fn absolute(path: &Path) -> PathBuf {
    let path = match std::env::current_dir() {
        Ok(cwd) if path.is_relative() => cwd.join(path),
        _ => path.to_path_buf(),
    };
    if let Ok(p) = path.canonicalize() {
        return p;
    }
    // A file that doesn't exist yet: canonicalize its directory instead.
    match (
        path.parent().and_then(|d| d.canonicalize().ok()),
        path.file_name(),
    ) {
        (Some(dir), Some(name)) => dir.join(name),
        _ => path,
    }
}

/// A short name for a path: relative to the working directory or home.
pub(crate) fn display_name(path: Option<&Path>) -> String {
    let Some(path) = path else {
        return "[No Name]".to_string();
    };
    if let Some(rel) = std::env::current_dir()
        .ok()
        .and_then(|cwd| cwd.canonicalize().ok())
        .and_then(|cwd| path.strip_prefix(cwd).ok().map(Path::to_path_buf))
    {
        return rel.display().to_string();
    }
    if let Some(rel) = std::env::var_os("HOME")
        .and_then(|home| path.strip_prefix(home).ok().map(Path::to_path_buf))
    {
        return format!("~/{}", rel.display());
    }
    path.display().to_string()
}
