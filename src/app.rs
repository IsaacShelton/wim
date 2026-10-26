//! The native window: translates egui input into editor keys and paints the
//! editor state (text, gutter, selection, cursor, status and command lines).

use std::path::PathBuf;

use eframe::egui::{
    self, Align2, Color32, Event, FontId, MouseWheelUnit, Pos2, Rect, Sense, TextFormat,
    ViewportCommand, text::LayoutJob,
};

use crate::editor::buffer::Pos;
use crate::editor::keys::{Key, KeyInput};
use crate::editor::{Editor, Mode, search};
use crate::highlight::{self, Token};

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
}

const FONT_SIZE: f32 = 15.0;
const LINE_SPACING: f32 = 1.3;
const TEXT_PADDING: f32 = 6.0;

/// Screen geometry for one frame.
struct Layout {
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
}

pub struct WimApp {
    editor: Editor,
    highlight_cache: highlight::Cache,
    scroll_remainder: f32,
    close_warned: bool,
    title: String,
}

impl WimApp {
    pub fn new(cc: &eframe::CreationContext<'_>, path: Option<PathBuf>) -> Self {
        cc.egui_ctx.set_visuals(egui::Visuals::dark());
        let mut editor = Editor::new();
        if let Some(path) = path {
            editor.open_file(&path);
        }
        Self {
            editor,
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
        let text_area = Rect::from_min_max(full.min, Pos2::new(full.max.x, bottom));
        let text_left = text_area.left() + self.gutter_cols() as f32 * char_w + TEXT_PADDING;
        let rows = ((text_area.height() / line_h).floor() as usize).max(1);
        let cols =
            (((text_area.right() - text_left - TEXT_PADDING) / char_w).floor() as usize).max(1);
        Layout {
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
        for event in events {
            match event {
                Event::Text(text) => {
                    for c in text.chars() {
                        self.key(KeyInput::ch(c));
                    }
                }
                Event::Ime(egui::ImeEvent::Commit(text)) => {
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
                            self.editor
                                .handle_keys(&crate::editor::keys::parse_keys("<Esc>:w<CR>"));
                        }
                        continue;
                    }
                    if let Some(k) = translate_key(key, modifiers) {
                        self.key(k);
                    }
                }
                Event::Paste(text) => self.editor.paste_text(&text),
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
                        self.editor.scroll_by(whole as isize);
                    }
                }
                _ => {}
            }
        }
    }

    fn key(&mut self, key: KeyInput) {
        self.close_warned = false;
        self.editor.handle_key(key);
    }

    fn handle_mouse(&mut self, ui: &mut egui::Ui, layout: &Layout) {
        let response = ui.interact(
            layout.text_area,
            ui.scope_id().with("wim-text"),
            Sense::click_and_drag(),
        );
        if response.drag_started()
            && let Some(p) = ui.ctx().input(|i| i.pointer.press_origin())
        {
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
            && self.editor.is_modified()
            && !self.close_warned
        {
            ctx.send_viewport_cmd(ViewportCommand::CancelClose);
            self.close_warned = true;
            self.editor.set_error(
                "E37: No write since last change (close again to discard, or :w to save)",
            );
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

            // Line number gutter.
            if gutter_cols > 0 {
                let (label, color) = if opts.relativenumber && line != cursor.line {
                    (line.abs_diff(cursor.line).to_string(), theme::GUTTER)
                } else if line == cursor.line {
                    ((line + 1).to_string(), theme::GUTTER_CURRENT)
                } else {
                    ((line + 1).to_string(), theme::GUTTER)
                };
                let x = layout.text_area.left() + (gutter_cols - 1) as f32 * cw;
                let align = if opts.relativenumber && line == cursor.line {
                    Align2::LEFT_TOP
                } else {
                    Align2::RIGHT_TOP
                };
                let x = if align == Align2::LEFT_TOP {
                    layout.text_area.left() + 2.0
                } else {
                    x
                };
                painter.text(
                    Pos2::new(x, y + layout.text_y),
                    align,
                    label,
                    font.clone(),
                    color,
                );
            }

            let chars = buf.line(line);
            let line_end_dcol = ed.display_col(line, chars.len());

            // Visual selection.
            if let Some(sel) = selection.filter(|s| (s.start.line..=s.end.line).contains(&line)) {
                let (from, to) = if sel.linewise {
                    (0, line_end_dcol + 1)
                } else {
                    let from = if line == sel.start.line {
                        ed.display_col(line, sel.start.col)
                    } else {
                        0
                    };
                    let to = if line == sel.end.line {
                        ed.display_col(line, sel.end.col + 1)
                    } else {
                        line_end_dcol + 1
                    };
                    (from, to)
                };
                let from = from.max(ed.scroll_left());
                if to > from {
                    let r =
                        Rect::from_min_max(Pos2::new(col_x(from), y), Pos2::new(col_x(to), y + lh));
                    painter.rect_filled(r, 0.0, theme::SELECTION);
                }
            }

            // Search matches.
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

            // Text.
            let spans = match lang {
                Some(lang) => {
                    let state = self
                        .highlight_cache
                        .state_at(lang, buf.version(), line, |i| buf.line(i));
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

    fn paint_status(&self, painter: &egui::Painter, layout: &Layout, font: &FontId) {
        let ed = &self.editor;
        let rect = layout.status;
        let cw = layout.char_w;
        let y = rect.top() + layout.text_y;
        painter.rect_filled(rect, 0.0, theme::STATUS_BG);

        let mode_color = match ed.mode() {
            Mode::Normal => theme::MODE_NORMAL,
            Mode::Insert => theme::MODE_INSERT,
            Mode::Replace => theme::MODE_REPLACE,
            Mode::Visual | Mode::VisualLine => theme::MODE_VISUAL,
            Mode::CmdLine(_) => theme::MODE_COMMAND,
        };
        let label = format!(" {} ", ed.mode_name());
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
            "{}   {filetype}   {}:{}   {position} ",
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
        self.handle_events(&ctx, &layout);
        self.handle_mouse(ui, &layout);

        // Editing may have changed the gutter width; lay out again.
        let layout = self.layout(&ctx, full);
        self.editor.set_viewport(layout.rows, layout.cols);
        self.editor.scroll_to_cursor();

        self.handle_close(&ctx);
        self.update_title(&ctx);
        let painter = ui.painter_at(full);
        self.paint(&painter, &layout);
    }
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
        K::Tab => Key::Tab,
        K::ArrowLeft => Key::Left,
        K::ArrowRight => Key::Right,
        K::ArrowUp => Key::Up,
        K::ArrowDown => Key::Down,
        K::Home => Key::Home,
        K::End => Key::End,
        K::PageUp => Key::PageUp,
        K::PageDown => Key::PageDown,
        _ if m.ctrl => {
            let mut symbol = key.symbol_or_name().chars();
            return match (symbol.next(), symbol.next()) {
                (Some(c), None) => Some(KeyInput::ctrl(c.to_ascii_lowercase())),
                _ => None,
            };
        }
        _ => return None,
    };
    Some(KeyInput::plain(named))
}
