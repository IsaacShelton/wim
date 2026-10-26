//! The native window: translates egui input into editor keys and paints the
//! editor state (file tree, buffer tabs, text, gutter, selection, cursor,
//! status and command lines).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eframe::egui::{
    self, Align2, Color32, Event, FontId, MouseWheelUnit, Pos2, Rect, Sense, Shape, Stroke,
    StrokeKind, TextFormat, ViewportCommand, text::LayoutJob,
};

use crate::editor::buffer::Pos;
use crate::editor::keys::{Key, KeyInput, parse_keys};
use crate::editor::{Editor, Mode, Range, search};
use crate::filetree::{FileTree, TreeAction};
use crate::highlight::{self, Token};
use crate::icons;
use crate::keymap::{self, Command, Keymap, Lookup, MapMode, Rhs};

mod theme {
    use eframe::egui::Color32;

    pub const BG: Color32 = Color32::from_rgb(0x28, 0x2c, 0x34);
    pub const FG: Color32 = Color32::from_rgb(0xab, 0xb2, 0xbf);
    pub const CURSOR_LINE: Color32 = Color32::from_rgb(0x2c, 0x31, 0x3c);
    pub const GUTTER: Color32 = Color32::from_rgb(0x4b, 0x52, 0x63);
    pub const GUTTER_CURRENT: Color32 = Color32::from_rgb(0xe5, 0xc0, 0x7b);
    pub const TILDE: Color32 = Color32::from_rgb(0x3b, 0x40, 0x48);
    pub const SELECTION: Color32 = Color32::from_rgb(0x3e, 0x44, 0x51);
    pub const SEARCH: Color32 = Color32::from_rgb(0x5c, 0x4f, 0x2e);
    pub const CURSOR: Color32 = Color32::from_rgb(0x52, 0x8b, 0xff);
    pub const STATUS_BG: Color32 = Color32::from_rgb(0x21, 0x25, 0x2b);
    pub const ERROR: Color32 = Color32::from_rgb(0xe0, 0x6c, 0x75);
    /// Yank flash, as `(r, g, b)`; the alpha fades over time.
    pub const FLASH: (u8, u8, u8) = (0xe5, 0xc0, 0x7b);

    pub const KEYWORD: Color32 = Color32::from_rgb(0xc6, 0x78, 0xdd);
    pub const TYPE: Color32 = Color32::from_rgb(0xe5, 0xc0, 0x7b);
    pub const CONSTANT: Color32 = Color32::from_rgb(0xd1, 0x9a, 0x66);
    pub const STRING: Color32 = Color32::from_rgb(0x98, 0xc3, 0x79);
    pub const COMMENT: Color32 = Color32::from_rgb(0x7f, 0x84, 0x8e);
    pub const FUNCTION: Color32 = Color32::from_rgb(0x61, 0xaf, 0xef);
    pub const MACRO: Color32 = Color32::from_rgb(0x56, 0xb6, 0xc2);

    pub const MODE_NORMAL: Color32 = Color32::from_rgb(0x61, 0xaf, 0xef);
    pub const MODE_INSERT: Color32 = Color32::from_rgb(0x98, 0xc3, 0x79);
    pub const MODE_VISUAL: Color32 = Color32::from_rgb(0xc6, 0x78, 0xdd);
    pub const MODE_REPLACE: Color32 = Color32::from_rgb(0xe0, 0x6c, 0x75);
    pub const MODE_COMMAND: Color32 = Color32::from_rgb(0xe5, 0xc0, 0x7b);
    pub const MODE_TREE: Color32 = Color32::from_rgb(0x56, 0xb6, 0xc2);
}

const FONT_SIZE: f32 = 15.0;
const LINE_SPACING: f32 = 1.3;
const TEXT_PADDING: f32 = 6.0;
/// Width of the file tree, in characters.
const SIDEBAR_COLS: f32 = 30.0;
const FLASH_DURATION: Duration = Duration::from_millis(300);

/// Screen geometry for one frame.
struct Layout {
    sidebar: Option<Rect>,
    tabline: Option<Rect>,
    text_area: Rect,
    text_left: f32,
    status: Rect,
    cmdline: Rect,
    char_w: f32,
    line_h: f32,
    /// Offset from a row's top to where its glyphs are drawn.
    text_y: f32,
    rows: usize,
    cols: usize,
    tree_rows: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Focus {
    Editor,
    Tree,
}

struct Flash {
    range: Range,
    buffer_id: usize,
    start: Instant,
}

pub struct WimApp {
    editor: Editor,
    keymap: Keymap,
    /// Keys typed so far that may be the start of a mapping.
    map_pending: Vec<KeyInput>,
    /// The mode `map_pending` is being matched in (`None`: no mappings apply).
    map_mode: Option<MapMode>,
    /// When an ambiguous or partial mapping stops waiting (`timeoutlen`).
    map_deadline: Option<Instant>,
    /// A mapping that needs one more typed character (`ç`, `∂`).
    awaiting_char: Option<Command>,
    /// Whether a Nerd Font was found, so file icons can be drawn.
    icons: bool,
    tree: FileTree,
    tree_visible: bool,
    focus: Focus,
    /// `<C-w>` was pressed; the next key picks a window.
    window_cmd_pending: bool,
    /// The file last revealed in the tree, to follow buffer switches.
    revealed: Option<PathBuf>,
    tree_cwd: Option<PathBuf>,
    flash: Option<Flash>,
    /// Buffer tabs from the last frame, for mouse clicks.
    tab_hits: Vec<(Rect, usize)>,
    highlight_cache: highlight::Cache,
    scroll_remainder: f32,
    close_warned: bool,
    title: String,
}

impl WimApp {
    pub fn new(cc: &eframe::CreationContext<'_>, path: Option<PathBuf>) -> Self {
        cc.egui_ctx.set_visuals(egui::Visuals::dark());
        let icons = install_icon_font(&cc.egui_ctx);
        // Launched from Finder the working directory is `/`; use the file's
        // directory instead so the tree and relative paths are useful.
        if std::env::current_dir().is_ok_and(|d| d.parent().is_none())
            && let Some(dir) = path.as_ref().and_then(|p| p.parent())
            && !dir.as_os_str().is_empty()
        {
            let _ = std::env::set_current_dir(dir);
        }
        let mut editor = Editor::new();
        if let Some(path) = path {
            editor.open_file(&path);
        }
        let root = current_dir();
        Self {
            editor,
            keymap: Keymap::from_neovim_config(),
            map_pending: Vec::new(),
            map_mode: None,
            map_deadline: None,
            awaiting_char: None,
            icons,
            tree: FileTree::new(root.clone()),
            tree_visible: false,
            focus: Focus::Editor,
            window_cmd_pending: false,
            revealed: None,
            tree_cwd: Some(root),
            flash: None,
            tab_hits: Vec::new(),
            highlight_cache: highlight::Cache::default(),
            scroll_remainder: 0.0,
            close_warned: false,
            title: String::new(),
        }
    }

    fn layout(&self, ctx: &egui::Context, full: Rect) -> Layout {
        let font = FontId::monospace(FONT_SIZE);
        let (char_w, row_h) = ctx.fonts_mut(|f| (f.glyph_width(&font, 'M'), f.row_height(&font)));
        let line_h = (row_h * LINE_SPACING).round();
        let bottom = full.max.y - 2.0 * line_h;

        let sidebar = self.tree_visible.then(|| {
            let width = (SIDEBAR_COLS * char_w).min(full.width() * 0.4);
            Rect::from_min_max(full.min, Pos2::new(full.min.x + width, bottom))
        });
        let editor_left = sidebar.map_or(full.min.x, |s| s.right() + 1.0);
        let tabline = (self.editor.buffer_list().len() > 1).then(|| {
            Rect::from_min_max(
                Pos2::new(editor_left, full.min.y),
                Pos2::new(full.max.x, full.min.y + line_h),
            )
        });
        let text_top = tabline.map_or(full.min.y, |t| t.bottom());
        let text_area = Rect::from_min_max(
            Pos2::new(editor_left, text_top),
            Pos2::new(full.max.x, bottom),
        );
        let text_left = text_area.left() + self.gutter_cols() as f32 * char_w + TEXT_PADDING;
        let rows = ((text_area.height() / line_h).floor() as usize).max(1);
        let cols =
            (((text_area.right() - text_left - TEXT_PADDING) / char_w).floor() as usize).max(1);
        let tree_rows = sidebar.map_or(1, |s| ((s.height() / line_h).floor() as usize).max(1));
        Layout {
            sidebar,
            tabline,
            text_area,
            text_left,
            status: Rect::from_min_max(
                Pos2::new(full.min.x, bottom),
                Pos2::new(full.max.x, bottom + line_h),
            ),
            cmdline: Rect::from_min_max(Pos2::new(full.min.x, bottom + line_h), full.max),
            char_w,
            line_h,
            text_y: ((line_h - row_h) / 2.0).round(),
            rows,
            cols,
            tree_rows,
        }
    }

    fn gutter_cols(&self) -> usize {
        let o = self.editor.options();
        if !o.number && !o.relativenumber {
            return 0;
        }
        let digits = self.editor.buffer().line_count().to_string().len();
        digits.max(3) + 1
    }

    // ----- Input -------------------------------------------------------------

    fn handle_events(&mut self, ctx: &egui::Context, layout: &Layout) {
        let events = ctx.input(|i| i.events.clone());
        let hover = ctx.input(|i| i.pointer.hover_pos());
        for event in events {
            match event {
                Event::Text(text) | Event::Ime(egui::ImeEvent::Commit(text)) => {
                    for c in text.chars() {
                        self.key(KeyInput::ch(c));
                    }
                }
                Event::Key {
                    key,
                    pressed: true,
                    modifiers,
                    ..
                } => {
                    if modifiers.mac_cmd {
                        if key == egui::Key::S {
                            self.editor.handle_keys(&parse_keys("<Esc>:w<CR>"));
                        }
                        continue;
                    }
                    if let Some(k) = translate_key(key, modifiers) {
                        self.key(k);
                    }
                }
                Event::Paste(text) if self.focus == Focus::Editor => self.editor.paste_text(&text),
                Event::Copy => self.editor.copy_selection(false),
                Event::Cut => self.editor.copy_selection(true),
                Event::MouseWheel { unit, delta, .. } => {
                    let lines = match unit {
                        MouseWheelUnit::Point => -delta.y / layout.line_h,
                        MouseWheelUnit::Line => -delta.y,
                        MouseWheelUnit::Page => -delta.y * layout.rows as f32,
                    };
                    self.scroll_remainder += lines;
                    let whole = self.scroll_remainder.trunc();
                    if whole != 0.0 {
                        self.scroll_remainder -= whole;
                        let over_tree = layout
                            .sidebar
                            .zip(hover)
                            .is_some_and(|(s, p)| s.contains(p));
                        if over_tree {
                            self.tree.scroll_by(whole as isize);
                        } else {
                            self.editor.scroll_by(whole as isize);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn key(&mut self, key: KeyInput) {
        self.close_warned = false;
        if let Some(command) = self.awaiting_char.take() {
            if let Some(c) = key.char() {
                let insert = if command == Command::InsertCharBefore {
                    'i'
                } else {
                    'a'
                };
                for k in [
                    KeyInput::ch(insert),
                    KeyInput::ch(c),
                    KeyInput::plain(Key::Esc),
                ] {
                    self.editor.handle_key(k);
                }
            }
            return;
        }
        if self.map_pending.is_empty() {
            self.map_mode = self.map_mode();
        }
        if self.map_mode.is_none() {
            self.dispatch(key);
            return;
        }
        self.map_pending.push(key);
        self.resolve_mappings(false);
    }

    /// The mapping mode for the next key, if mappings apply right now. Like
    /// Neovim's Normal-mode maps, they don't apply in the middle of a command
    /// (so `df,` still finds a comma even though `,` is the leader).
    fn map_mode(&self) -> Option<MapMode> {
        if self.focus == Focus::Tree {
            return Some(MapMode::Normal);
        }
        if !self.editor.pending_keys().is_empty() || self.window_cmd_pending {
            return None;
        }
        match self.editor.mode() {
            Mode::Normal => Some(MapMode::Normal),
            Mode::Visual | Mode::VisualLine => Some(MapMode::Visual),
            Mode::Insert | Mode::Replace => Some(MapMode::Insert),
            Mode::CmdLine(_) => None,
        }
    }

    /// Run a complete mapping in `map_pending`, keep waiting on a partial or
    /// ambiguous one, or pass keys through unmapped.
    fn resolve_mappings(&mut self, mut timed_out: bool) {
        while !self.map_pending.is_empty() {
            let Some(mode) = self.map_mode else {
                for k in std::mem::take(&mut self.map_pending) {
                    self.dispatch(k);
                }
                break;
            };
            let in_tree = self.focus == Focus::Tree;
            let found = match self.keymap.lookup(mode, &self.map_pending, in_tree) {
                Lookup::Exact { rhs, ambiguous } if timed_out || !ambiguous => {
                    Some(Some(rhs.clone()))
                }
                Lookup::Exact { .. } | Lookup::Prefix if !timed_out => Some(None),
                _ => None,
            };
            match found {
                Some(Some(rhs)) => {
                    self.map_pending.clear();
                    self.map_deadline = None;
                    self.run_mapping(rhs);
                    return;
                }
                Some(None) => {
                    self.map_deadline = Some(Instant::now() + keymap::TIMEOUT);
                    return;
                }
                None => {
                    // Not a mapping: type the first key as is, then look at
                    // the rest again.
                    let first = self.map_pending.remove(0);
                    self.dispatch(first);
                    self.map_mode = self.map_mode();
                    timed_out = false;
                }
            }
        }
        self.map_deadline = None;
    }

    fn run_mapping(&mut self, rhs: Rhs) {
        match rhs {
            Rhs::Keys(keys) => {
                for k in keys {
                    self.editor.handle_key(k);
                }
            }
            Rhs::Command(command) => match command {
                Command::WindowLeft => {
                    if self.tree_visible {
                        self.editor_to_normal();
                        self.focus = Focus::Tree;
                    }
                }
                Command::WindowRight => self.focus = Focus::Editor,
                // There are no splits above or below.
                Command::WindowUp | Command::WindowDown => {}
                Command::ToggleTree => self.toggle_tree(),
                Command::InsertCharBefore | Command::InsertCharAfter => {
                    self.awaiting_char = Some(command);
                }
            },
        }
    }

    /// Send an (unmapped) key to whichever pane has focus.
    fn dispatch(&mut self, key: KeyInput) {
        if self.window_cmd_pending {
            self.window_cmd_pending = false;
            self.window_command(key);
            return;
        }
        let editor_idle =
            self.editor.mode() == Mode::Normal && self.editor.pending_keys().is_empty();
        if key == KeyInput::ctrl('w')
            && self.tree_visible
            && (self.focus == Focus::Tree || editor_idle)
        {
            self.window_cmd_pending = true;
            return;
        }
        match self.focus {
            Focus::Editor => self.editor.handle_key(key),
            Focus::Tree => match self.tree.handle_key(key) {
                TreeAction::Open(path) => self.open_from_tree(&path),
                TreeAction::Close => {
                    self.tree_visible = false;
                    self.focus = Focus::Editor;
                }
                TreeAction::FocusEditor => self.focus = Focus::Editor,
                TreeAction::None => {}
            },
        }
    }

    /// `<C-w>h`/`l`/`w`: move focus between the tree and the editor.
    fn window_command(&mut self, key: KeyInput) {
        let to_tree = match key.key {
            Key::Char('h') | Key::Backspace | Key::Left => true,
            Key::Char('l') | Key::Right => false,
            Key::Char('w') => self.focus == Focus::Editor,
            _ => return,
        };
        if to_tree {
            self.editor_to_normal();
            self.focus = Focus::Tree;
        } else {
            self.focus = Focus::Editor;
        }
    }

    fn toggle_tree(&mut self) {
        self.window_cmd_pending = false;
        if self.tree_visible {
            self.tree_visible = false;
            self.focus = Focus::Editor;
            return;
        }
        self.editor_to_normal();
        self.tree.refresh();
        self.revealed = None;
        self.tree_visible = true;
        self.focus = Focus::Tree;
    }

    fn open_from_tree(&mut self, path: &std::path::Path) {
        self.editor_to_normal();
        self.editor.open_file(path);
        self.focus = Focus::Editor;
    }

    /// Leave Insert, Visual or command-line mode before focus moves away.
    fn editor_to_normal(&mut self) {
        if self.editor.mode() != Mode::Normal || !self.editor.pending_keys().is_empty() {
            self.editor.handle_key(KeyInput::plain(Key::Esc));
        }
    }

    /// Keep the tree rooted at the working directory and showing the
    /// current file.
    fn sync_tree(&mut self, layout: &Layout) {
        if !self.tree_visible {
            return;
        }
        let cwd = std::env::current_dir().ok();
        if cwd != self.tree_cwd {
            self.tree.set_root(current_dir());
            self.tree_cwd = cwd;
            self.revealed = None;
        }
        self.tree.set_view_rows(layout.tree_rows);
        let file = self.editor.file_path().map(|p| p.to_path_buf());
        if file.is_some() && file != self.revealed {
            if let Some(p) = &file {
                self.tree.reveal(p);
            }
            self.revealed = file;
        }
    }

    fn handle_mouse(&mut self, ui: &mut egui::Ui, layout: &Layout) {
        if let Some(sidebar) = layout.sidebar {
            let response = ui.interact(sidebar, ui.scope_id().with("wim-tree"), Sense::click());
            if response.clicked()
                && let Some(p) = response.interact_pointer_pos()
            {
                let row = ((p.y - sidebar.top()) / layout.line_h).floor() as usize;
                if self.tree.scroll() + row < self.tree.rows().len() {
                    self.editor_to_normal();
                    self.focus = Focus::Tree;
                    self.tree.select(self.tree.scroll() + row);
                    if let TreeAction::Open(path) = self.tree.activate() {
                        self.open_from_tree(&path);
                    }
                }
            }
        }

        if let Some(tabline) = layout.tabline {
            let response = ui.interact(tabline, ui.scope_id().with("wim-tabs"), Sense::click());
            if response.clicked()
                && let Some(p) = response.interact_pointer_pos()
                && let Some(&(_, id)) = self.tab_hits.iter().find(|(r, _)| r.contains(p))
            {
                self.editor_to_normal();
                self.editor.switch_to_buffer(id);
                self.focus = Focus::Editor;
            }
        }

        let response = ui.interact(
            layout.text_area,
            ui.scope_id().with("wim-text"),
            Sense::click_and_drag(),
        );
        if response.drag_started()
            && let Some(p) = ui.ctx().input(|i| i.pointer.press_origin())
        {
            self.focus = Focus::Editor;
            let pos = self.pos_at(layout, p);
            self.editor.click(pos);
        }
        if response.dragged() {
            if let Some(p) = response.interact_pointer_pos() {
                let pos = self.pos_at(layout, p);
                self.editor.drag_to(pos);
            }
        } else if response.clicked()
            && let Some(p) = response.interact_pointer_pos()
        {
            self.focus = Focus::Editor;
            let pos = self.pos_at(layout, p);
            self.editor.click(pos);
        }
    }

    fn pos_at(&self, layout: &Layout, p: Pos2) -> Pos {
        let last = self.editor.buffer().last_line();
        let row = ((p.y - layout.text_area.top()) / layout.line_h)
            .floor()
            .max(0.0) as usize;
        let line = (self.editor.scroll_top() + row).min(last);
        let dcol = ((p.x - layout.text_left) / layout.char_w).floor().max(0.0) as usize
            + self.editor.scroll_left();
        Pos::new(line, self.editor.col_from_display(line, dcol))
    }

    fn handle_close(&mut self, ctx: &egui::Context) {
        if ctx.input(|i| i.viewport().close_requested())
            && !self.editor.quit_requested()
            && !self.close_warned
            && let Some(buffer) = self.editor.first_modified_buffer()
        {
            ctx.send_viewport_cmd(ViewportCommand::CancelClose);
            self.close_warned = true;
            self.editor.set_error(format!(
                "E37: No write since last change in \"{}\" (close again to discard, or :wa to save)",
                buffer.name
            ));
        }
        if self.editor.quit_requested() {
            ctx.send_viewport_cmd(ViewportCommand::Close);
        }
    }

    fn update_title(&mut self, ctx: &egui::Context) {
        let modified = if self.editor.is_modified() {
            " [+]"
        } else {
            ""
        };
        let title = format!("{}{modified} - Wim", self.editor.file_name());
        if title != self.title {
            ctx.send_viewport_cmd(ViewportCommand::Title(title.clone()));
            self.title = title;
        }
    }

    /// Start a flash for a new yank; returns whether one is still showing.
    fn update_flash(&mut self) -> bool {
        if let Some(range) = self.editor.take_yank_flash() {
            self.flash = Some(Flash {
                range,
                buffer_id: self.editor.buffer_id(),
                start: Instant::now(),
            });
        }
        let active = self.flash.as_ref().is_some_and(|f| {
            f.start.elapsed() < FLASH_DURATION && f.buffer_id == self.editor.buffer_id()
        });
        if !active {
            self.flash = None;
        }
        active
    }

    // ----- Painting ------------------------------------------------------------

    fn paint(&mut self, painter: &egui::Painter, layout: &Layout) {
        let font = FontId::monospace(FONT_SIZE);
        painter.rect_filled(painter.clip_rect(), 0.0, theme::BG);

        let ed = &self.editor;
        let buf = ed.buffer();
        let opts = ed.options();
        let cursor = ed.cursor();
        let selection = ed.selection();
        let search_re = ed.highlight_regex();
        let lang = highlight::detect(ed.file_path());
        let gutter_cols = self.gutter_cols();
        let (cw, lh) = (layout.char_w, layout.line_h);
        let col_x =
            |dcol: usize| layout.text_left + dcol.saturating_sub(ed.scroll_left()) as f32 * cw;
        let visible = |dcol: usize| dcol >= ed.scroll_left();
        let flash_color = self.flash.as_ref().map(|f| {
            let fade = 1.0 - f.start.elapsed().as_secs_f32() / FLASH_DURATION.as_secs_f32();
            let (r, g, b) = theme::FLASH;
            Color32::from_rgba_unmultiplied(r, g, b, (fade.clamp(0.0, 1.0) * 120.0) as u8)
        });
        // Fill the display columns of `line` covered by a region.
        let fill_region =
            |line: usize, y: f32, start: Pos, end: Pos, linewise: bool, color: Color32| {
                if line < start.line || line > end.line {
                    return;
                }
                let line_end = ed.display_col(line, buf.line_len(line)) + 1;
                let (from, to) = if linewise {
                    (0, line_end)
                } else {
                    let from = if line == start.line {
                        ed.display_col(line, start.col)
                    } else {
                        0
                    };
                    let to = if line == end.line {
                        ed.display_col(line, end.col)
                    } else {
                        line_end
                    };
                    (from, to)
                };
                let from = from.max(ed.scroll_left());
                if to > from {
                    let r =
                        Rect::from_min_max(Pos2::new(col_x(from), y), Pos2::new(col_x(to), y + lh));
                    painter.rect_filled(r, 0.0, color);
                }
            };

        for row in 0..layout.rows {
            let line = ed.scroll_top() + row;
            let y = layout.text_area.top() + row as f32 * lh;
            let row_rect = Rect::from_min_max(
                Pos2::new(layout.text_area.left(), y),
                Pos2::new(layout.text_area.right(), y + lh),
            );
            if line > buf.last_line() {
                painter.text(
                    Pos2::new(layout.text_area.left() + TEXT_PADDING, y + layout.text_y),
                    Align2::LEFT_TOP,
                    "~",
                    font.clone(),
                    theme::TILDE,
                );
                continue;
            }
            if line == cursor.line && selection.is_none() {
                painter.rect_filled(row_rect, 0.0, theme::CURSOR_LINE);
            }

            // Line number gutter: relative numbers, with the absolute number
            // on the cursor line (Vim's `number` + `relativenumber`).
            if gutter_cols > 0 {
                let current = line == cursor.line;
                let label = if opts.relativenumber && !current {
                    line.abs_diff(cursor.line).to_string()
                } else {
                    (line + 1).to_string()
                };
                let color = if current {
                    theme::GUTTER_CURRENT
                } else {
                    theme::GUTTER
                };
                let (x, align) = if opts.relativenumber && opts.number && current {
                    (layout.text_area.left() + 2.0, Align2::LEFT_TOP)
                } else {
                    (
                        layout.text_area.left() + (gutter_cols - 1) as f32 * cw,
                        Align2::RIGHT_TOP,
                    )
                };
                painter.text(
                    Pos2::new(x, y + layout.text_y),
                    align,
                    label,
                    font.clone(),
                    color,
                );
            }

            if let Some(sel) = selection {
                let end = Pos::new(sel.end.line, sel.end.col + 1);
                fill_region(line, y, sel.start, end, sel.linewise, theme::SELECTION);
            }

            let chars = buf.line(line);
            if let Some(re) = &search_re {
                for (s, e) in search::line_matches(re, chars) {
                    let (ds, de) = (ed.display_col(line, s), ed.display_col(line, e));
                    if de > ds && visible(de) {
                        let r = Rect::from_min_max(
                            Pos2::new(col_x(ds.max(ed.scroll_left())), y),
                            Pos2::new(col_x(de), y + lh),
                        );
                        painter.rect_filled(r, 2.0, theme::SEARCH);
                    }
                }
            }

            if let (Some(flash), Some(color)) = (&self.flash, flash_color) {
                let r = flash.range;
                fill_region(line, y, r.start, r.end, r.linewise, color);
            }

            let spans = match lang {
                Some(lang) => {
                    let key = (ed.buffer_id(), buf.version());
                    let state = self
                        .highlight_cache
                        .state_at(lang, key, line, |i| buf.line(i));
                    highlight::highlight_line(lang, chars, state).0
                }
                None => Vec::new(),
            };
            let job = line_job(
                chars,
                &spans,
                opts.tabstop,
                ed.scroll_left(),
                layout.cols + 1,
                &font,
            );
            let galley = painter.layout_job(job);
            painter.galley(
                Pos2::new(layout.text_left, y + layout.text_y),
                galley,
                theme::FG,
            );
        }

        self.paint_cursor(painter, layout, &font);
        self.paint_tabline(painter, layout, &font);
        self.paint_tree(painter, layout, &font);
        self.paint_status(painter, layout, &font);
        self.paint_cmdline(painter, layout, &font);
    }

    fn paint_cursor(&self, painter: &egui::Painter, layout: &Layout, font: &FontId) {
        let ed = &self.editor;
        let mode = ed.mode();
        let cursor = ed.cursor();
        if matches!(mode, Mode::CmdLine(_))
            || cursor.line < ed.scroll_top()
            || cursor.line >= ed.scroll_top() + layout.rows
        {
            return;
        }
        let dcol = ed.display_col(cursor.line, cursor.col);
        if dcol < ed.scroll_left() {
            return;
        }
        let ch = ed.buffer().char_at(cursor).unwrap_or(' ');
        let width = if ch == '\t' {
            ed.display_col(cursor.line, cursor.col + 1) - dcol
        } else {
            1
        };
        let x = layout.text_left + (dcol - ed.scroll_left()) as f32 * layout.char_w;
        let y = layout.text_area.top() + (cursor.line - ed.scroll_top()) as f32 * layout.line_h;
        let cell = Rect::from_min_size(
            Pos2::new(x, y),
            egui::vec2(layout.char_w * width as f32, layout.line_h),
        );
        if self.focus == Focus::Tree {
            // Hollow cursor while the file tree has focus.
            painter.rect_stroke(
                cell,
                0.0,
                Stroke::new(1.0, theme::CURSOR),
                StrokeKind::Inside,
            );
            return;
        }
        match mode {
            Mode::Insert => {
                painter.rect_filled(
                    Rect::from_min_size(cell.min, egui::vec2(2.0, cell.height())),
                    0.0,
                    theme::CURSOR,
                );
            }
            _ if mode == Mode::Replace || !ed.pending_keys().is_empty() => {
                let bar = Rect::from_min_max(Pos2::new(cell.left(), cell.bottom() - 3.0), cell.max);
                painter.rect_filled(bar, 0.0, theme::CURSOR);
            }
            _ => {
                painter.rect_filled(cell, 0.0, theme::CURSOR);
                if !ch.is_whitespace() {
                    painter.text(
                        Pos2::new(x, y + layout.text_y),
                        Align2::LEFT_TOP,
                        ch,
                        font.clone(),
                        theme::BG,
                    );
                }
            }
        }
    }

    /// One tab per buffer across the top of the editor, bufferline-style:
    /// file icon, name and a dot for unsaved changes.
    fn paint_tabline(&mut self, painter: &egui::Painter, layout: &Layout, font: &FontId) {
        self.tab_hits.clear();
        let Some(rect) = layout.tabline else {
            return;
        };
        let cw = layout.char_w;
        painter.rect_filled(rect, 0.0, theme::STATUS_BG);
        let painter = painter.with_clip_rect(rect);
        let y = rect.top() + layout.text_y;
        let mut x = rect.left();
        for buffer in self.editor.buffer_list() {
            let short = buffer.name.rsplit('/').next().unwrap_or(&buffer.name);
            let icon_cols = if self.icons { 2 } else { 0 };
            let width = (short.chars().count() + icon_cols + 4) as f32 * cw;
            let tab =
                Rect::from_min_size(Pos2::new(x, rect.top()), egui::vec2(width, rect.height()));
            let text_color = if buffer.active {
                painter.rect_filled(tab, 0.0, theme::BG);
                let underline = Rect::from_min_size(tab.min, egui::vec2(width, 2.0));
                painter.rect_filled(underline, 0.0, theme::MODE_NORMAL);
                theme::FG
            } else {
                theme::COMMENT
            };
            let mut tx = x + cw;
            if self.icons {
                let icon = icons::for_file(short);
                let color = if buffer.active {
                    rgb(icon.color)
                } else {
                    theme::COMMENT
                };
                painter.text(
                    Pos2::new(tx, y),
                    Align2::LEFT_TOP,
                    icon.glyph,
                    font.clone(),
                    color,
                );
                tx += 2.0 * cw;
            }
            painter.text(
                Pos2::new(tx, y),
                Align2::LEFT_TOP,
                short,
                font.clone(),
                text_color,
            );
            if buffer.modified {
                let dot = Pos2::new(tab.right() - 1.5 * cw, y);
                painter.text(
                    dot,
                    Align2::LEFT_TOP,
                    '●',
                    font.clone(),
                    theme::GUTTER_CURRENT,
                );
            }
            self.tab_hits.push((tab, buffer.id));
            x += width + 1.0;
        }
    }

    /// The tree, styled after the nvim-tree setup: no root label, folder and
    /// file icons instead of arrows.
    fn paint_tree(&self, painter: &egui::Painter, layout: &Layout, font: &FontId) {
        let Some(rect) = layout.sidebar else {
            return;
        };
        let (cw, lh) = (layout.char_w, layout.line_h);
        painter.rect_filled(rect, 0.0, theme::STATUS_BG);
        painter.vline(
            rect.right() + 0.5,
            rect.y_range(),
            Stroke::new(1.0, theme::TILDE),
        );
        let painter = painter.with_clip_rect(rect);

        let current_file = self.editor.file_path();
        let first = self.tree.scroll();
        let rows = self
            .tree
            .rows()
            .iter()
            .enumerate()
            .skip(first)
            .take(layout.tree_rows);
        for (i, row) in rows {
            let y = rect.top() + lh * (i - first) as f32;
            if i == self.tree.selected() {
                let color = if self.focus == Focus::Tree {
                    theme::SELECTION
                } else {
                    theme::CURSOR_LINE
                };
                let r =
                    Rect::from_min_max(Pos2::new(rect.left(), y), Pos2::new(rect.right(), y + lh));
                painter.rect_filled(r, 0.0, color);
            }
            let x = rect.left() + TEXT_PADDING + (row.depth * 2) as f32 * cw;
            if self.icons {
                let (glyph, color) = if row.is_dir {
                    let glyph = match (row.expanded, row.empty) {
                        (false, false) => icons::FOLDER_CLOSED,
                        (true, false) => icons::FOLDER_OPEN,
                        (false, true) => icons::FOLDER_EMPTY,
                        (true, true) => icons::FOLDER_EMPTY_OPEN,
                    };
                    (glyph, theme::FUNCTION)
                } else {
                    let icon = icons::for_file(&row.name);
                    (icon.glyph, rgb(icon.color))
                };
                painter.text(
                    Pos2::new(x, y + layout.text_y),
                    Align2::LEFT_TOP,
                    glyph,
                    font.clone(),
                    color,
                );
            } else if row.is_dir {
                paint_disclosure_triangle(
                    &painter,
                    Pos2::new(x + cw * 0.5, y + lh * 0.5),
                    cw,
                    row.expanded,
                );
            }
            let color = if row.is_dir {
                theme::FUNCTION
            } else if current_file == Some(row.path.as_path()) {
                theme::GUTTER_CURRENT
            } else {
                theme::FG
            };
            painter.text(
                Pos2::new(x + cw * 2.0, y + layout.text_y),
                Align2::LEFT_TOP,
                &row.name,
                font.clone(),
                color,
            );
        }
    }

    fn paint_status(&self, painter: &egui::Painter, layout: &Layout, font: &FontId) {
        let ed = &self.editor;
        let rect = layout.status;
        let cw = layout.char_w;
        let y = rect.top() + layout.text_y;
        painter.rect_filled(rect, 0.0, theme::STATUS_BG);

        let (mode_name, mode_color) = if self.focus == Focus::Tree {
            ("TREE", theme::MODE_TREE)
        } else {
            let color = match ed.mode() {
                Mode::Normal => theme::MODE_NORMAL,
                Mode::Insert => theme::MODE_INSERT,
                Mode::Replace => theme::MODE_REPLACE,
                Mode::Visual | Mode::VisualLine => theme::MODE_VISUAL,
                Mode::CmdLine(_) => theme::MODE_COMMAND,
            };
            (ed.mode_name(), color)
        };
        let label = format!(" {mode_name} ");
        let pill =
            Rect::from_min_size(rect.min, egui::vec2(label.len() as f32 * cw, rect.height()));
        painter.rect_filled(pill, 0.0, mode_color);
        painter.text(
            Pos2::new(pill.left(), y),
            Align2::LEFT_TOP,
            &label,
            font.clone(),
            theme::BG,
        );

        let modified = if ed.is_modified() { " [+]" } else { "" };
        let name = format!(" {}{modified}", ed.file_name());
        painter.text(
            Pos2::new(pill.right(), y),
            Align2::LEFT_TOP,
            name,
            font.clone(),
            theme::FG,
        );

        let cursor = ed.cursor();
        let lines = ed.buffer().line_count();
        let position = if lines <= layout.rows {
            "All".to_string()
        } else if ed.scroll_top() == 0 {
            "Top".to_string()
        } else if ed.scroll_top() + layout.rows >= lines {
            "Bot".to_string()
        } else {
            format!("{}%", ed.scroll_top() * 100 / (lines - layout.rows))
        };
        let filetype = highlight::detect(ed.file_path()).map_or("", |l| l.name);
        let right = format!(
            "{}{}   {filetype}   {}:{}   {position} ",
            self.map_pending
                .iter()
                .map(|k| k.to_string())
                .collect::<String>(),
            ed.pending_keys(),
            cursor.line + 1,
            ed.display_col(cursor.line, cursor.col) + 1
        );
        painter.text(
            Pos2::new(rect.right() - cw, y),
            Align2::RIGHT_TOP,
            right,
            font.clone(),
            theme::FG,
        );
    }

    fn paint_cmdline(&self, painter: &egui::Painter, layout: &Layout, font: &FontId) {
        let ed = &self.editor;
        let rect = layout.cmdline;
        let pos = Pos2::new(rect.left() + TEXT_PADDING, rect.top() + layout.text_y);
        if let Some(text) = ed.cmdline() {
            let end = painter.text(pos, Align2::LEFT_TOP, &text, font.clone(), theme::FG);
            let bar = Rect::from_min_size(
                Pos2::new(end.right(), rect.top()),
                egui::vec2(2.0, layout.line_h),
            );
            painter.rect_filled(bar, 0.0, theme::CURSOR);
        } else if let Some(msg) = ed.message() {
            let color = if msg.error { theme::ERROR } else { theme::FG };
            painter.text(pos, Align2::LEFT_TOP, &msg.text, font.clone(), color);
        }
    }
}

impl eframe::App for WimApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        let full = ui.max_rect();

        let layout = self.layout(&ctx, full);
        self.editor.set_viewport(layout.rows, layout.cols);
        if self.map_deadline.is_some_and(|d| Instant::now() >= d) {
            self.resolve_mappings(true);
        }
        self.handle_events(&ctx, &layout);
        self.handle_mouse(ui, &layout);

        // Input may have changed the gutter, tabs or sidebar; lay out again.
        let layout = self.layout(&ctx, full);
        self.editor.set_viewport(layout.rows, layout.cols);
        self.editor.scroll_to_cursor();
        self.sync_tree(&layout);
        if self.update_flash() {
            ctx.request_repaint();
        }
        if let Some(deadline) = self.map_deadline {
            ctx.request_repaint_after(deadline.saturating_duration_since(Instant::now()));
        }

        self.handle_close(&ctx);
        self.update_title(&ctx);
        let painter = ui.painter_at(full);
        self.paint(&painter, &layout);
    }
}

fn current_dir() -> PathBuf {
    std::env::current_dir()
        .and_then(|d| d.canonicalize())
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn rgb(color: u32) -> Color32 {
    Color32::from_rgb((color >> 16) as u8, (color >> 8) as u8, color as u8)
}

/// Folder arrows, used when no Nerd Font is installed for icons.
fn paint_disclosure_triangle(painter: &egui::Painter, center: Pos2, char_w: f32, open: bool) {
    let (cx, cy, s) = (center.x, center.y, char_w * 0.32);
    let points = if open {
        vec![
            Pos2::new(cx - s, cy - s * 0.6),
            Pos2::new(cx + s, cy - s * 0.6),
            Pos2::new(cx, cy + s * 0.7),
        ]
    } else {
        vec![
            Pos2::new(cx - s * 0.6, cy - s),
            Pos2::new(cx + s * 0.7, cy),
            Pos2::new(cx - s * 0.6, cy + s),
        ]
    };
    painter.add(Shape::convex_polygon(points, theme::COMMENT, Stroke::NONE));
}

/// Add an installed Nerd Font right after the default monospace font, so
/// its icon glyphs are used ahead of egui's own icon font, which shares
/// some private-use codepoints. Returns whether one was found.
fn install_icon_font(ctx: &egui::Context) -> bool {
    let Some(bytes) = find_nerd_font().and_then(|p| std::fs::read(p).ok()) else {
        return false;
    };
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "nerd-font".into(),
        Arc::new(egui::FontData::from_owned(bytes)),
    );
    fonts
        .families
        .entry(egui::FontFamily::Monospace)
        .or_default()
        .insert(1, "nerd-font".into());
    ctx.set_fonts(fonts);
    true
}

fn find_nerd_font() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let dirs = [
        home.join("Library/Fonts"),
        PathBuf::from("/Library/Fonts"),
        home.join(".local/share/fonts"),
        home.join(".fonts"),
        PathBuf::from("/usr/share/fonts"),
    ];
    let mut fonts: Vec<PathBuf> = dirs
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            name.contains("NerdFont")
                && name.contains("Regular")
                && (name.ends_with(".ttf") || name.ends_with(".otf"))
        })
        .collect();
    fonts.sort();
    // The "Mono" variants keep icons one cell wide.
    let mono = fonts
        .iter()
        .find(|p| p.to_string_lossy().contains("NerdFontMono-"));
    mono.or(fonts.first()).cloned()
}

fn token_color(token: Token) -> Color32 {
    match token {
        Token::Normal => theme::FG,
        Token::Keyword => theme::KEYWORD,
        Token::Type => theme::TYPE,
        Token::Constant | Token::Number => theme::CONSTANT,
        Token::String => theme::STRING,
        Token::Comment => theme::COMMENT,
        Token::Function => theme::FUNCTION,
        Token::Macro => theme::MACRO,
    }
}

/// Build the visible part of a line as a colored layout job, expanding tabs.
fn line_job(
    chars: &[char],
    spans: &[(usize, usize, Token)],
    tabstop: usize,
    left: usize,
    width: usize,
    font: &FontId,
) -> LayoutJob {
    let mut job = LayoutJob::default();
    let mut run = String::new();
    let mut run_color = theme::FG;
    let flush = |job: &mut LayoutJob, run: &mut String, color: Color32| {
        if !run.is_empty() {
            job.append(
                run,
                0.0,
                TextFormat {
                    font_id: font.clone(),
                    color,
                    ..Default::default()
                },
            );
            run.clear();
        }
    };
    let ts = tabstop.max(1);
    let right = left + width;
    let mut span = 0;
    let mut dcol = 0;
    for (i, &c) in chars.iter().enumerate() {
        if dcol >= right {
            break;
        }
        while span < spans.len() && spans[span].1 <= i {
            span += 1;
        }
        let token = spans
            .get(span)
            .filter(|s| s.0 <= i)
            .map_or(Token::Normal, |s| s.2);
        let color = token_color(token);
        let cells = if c == '\t' { ts - dcol % ts } else { 1 };
        for k in 0..cells {
            if (left..right).contains(&(dcol + k)) {
                if color != run_color {
                    flush(&mut job, &mut run, run_color);
                    run_color = color;
                }
                run.push(if c == '\t' { ' ' } else { c });
            }
        }
        dcol += cells;
    }
    flush(&mut job, &mut run, run_color);
    job
}

fn translate_key(key: egui::Key, m: egui::Modifiers) -> Option<KeyInput> {
    use egui::Key as K;
    let named = match key {
        K::Escape => Key::Esc,
        K::Enter => Key::Enter,
        K::Backspace => Key::Backspace,
        K::Delete => Key::Delete,
        K::Tab if m.shift => Key::BackTab,
        K::Tab => Key::Tab,
        K::ArrowLeft => Key::Left,
        K::ArrowRight => Key::Right,
        K::ArrowUp => Key::Up,
        K::ArrowDown => Key::Down,
        K::Home => Key::Home,
        K::End => Key::End,
        K::PageUp => Key::PageUp,
        K::PageDown => Key::PageDown,
        // Option+Shift+K types U+F8FF (the Apple logo), which egui drops as a
        // private-use character; recreate it for the mapping that uses it.
        K::K if m.alt && m.shift && !m.ctrl => return Some(KeyInput::ch('\u{f8ff}')),
        _ if m.ctrl => {
            let mut symbol = key.symbol_or_name().chars();
            return match (symbol.next(), symbol.next()) {
                (Some(c), None) => Some(KeyInput::ctrl(c.to_ascii_lowercase())),
                _ => None,
            };
        }
        _ => return None,
    };
    // Option (Alt) on the editing keys gives macOS word movement/deletion.
    Some(if m.alt {
        KeyInput::alt(named)
    } else {
        KeyInput::plain(named)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With a Nerd Font installed, every icon the tree and tabs use renders.
    #[test]
    fn icon_glyphs_are_in_the_nerd_font() {
        let has_glyph = |ctx: &egui::Context, c: char| {
            let mut output = ctx.run_ui(egui::RawInput::default(), |_| {});
            output.textures_delta.clear();
            ctx.fonts_mut(|f| f.has_glyph(&FontId::monospace(FONT_SIZE), c))
        };
        // Without a Nerd Font, egui can't draw these icons at all.
        assert!(!has_glyph(
            &egui::Context::default(),
            icons::DEFAULT_FILE.glyph
        ));

        let ctx = egui::Context::default();
        if !install_icon_font(&ctx) {
            return; // No Nerd Font on this machine.
        }
        let mut output = ctx.run_ui(egui::RawInput::default(), |_| {});
        output.textures_delta.clear();
        let font = FontId::monospace(FONT_SIZE);
        let glyphs = [
            icons::FOLDER_CLOSED,
            icons::FOLDER_OPEN,
            icons::FOLDER_EMPTY,
            icons::FOLDER_EMPTY_OPEN,
            icons::DEFAULT_FILE.glyph,
            icons::for_file("main.rs").glyph,
            icons::for_file("Cargo.toml").glyph,
            icons::for_file("README.md").glyph,
            icons::for_file("index.ts").glyph,
            icons::for_file("x.c").glyph,
        ];
        ctx.fonts_mut(|f| {
            for g in glyphs {
                assert!(f.has_glyph(&font, g), "missing U+{:X}", g as u32);
            }
            assert!(f.has_glyph(&font, '●'));
        });
    }
}
