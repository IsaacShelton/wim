//! Operators and the other buffer-changing Normal/Visual mode commands.

use super::buffer::Pos;
use super::command::{InsertKind, Motion, Operator, Scroll, Target, TextObject};
use super::motion::{MotionKind, MotionTarget, end_of_run, is_keyword};
use super::registers::{Register, RegisterOp};
use super::{Editor, LastSearch, Mode, order};

/// A region of text. Charwise ranges have an exclusive end; linewise ranges
/// cover the lines `start.line..=end.line`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub start: Pos,
    pub end: Pos,
    pub linewise: bool,
}

impl Range {
    pub fn chars(start: Pos, end: Pos) -> Self {
        Self {
            start,
            end,
            linewise: false,
        }
    }

    pub fn lines(first: usize, last: usize) -> Self {
        Self {
            start: Pos::new(first, 0),
            end: Pos::new(last, 0),
            linewise: true,
        }
    }
}

impl Editor {
    pub(crate) fn operate(
        &mut self,
        op: Operator,
        target: Target,
        count: Option<usize>,
        reg: Option<char>,
    ) {
        let n = count.unwrap_or(1);
        let range = match target {
            Target::Line => {
                let last = (self.cursor.line + n - 1).min(self.buffer.last_line());
                Range::lines(self.cursor.line, last)
            }
            Target::Object { obj, around } => match self.text_object(obj, around, n) {
                Some(r) => r,
                None => return,
            },
            Target::Motion(m) => {
                let target = match m {
                    // `cw` on a word behaves like `ce`.
                    Motion::WordForward { big }
                        if op == Operator::Change
                            && self
                                .buffer
                                .char_at(self.cursor)
                                .is_some_and(|c| !c.is_whitespace()) =>
                    {
                        let mut p = end_of_run(&self.buffer, self.cursor, big);
                        for _ in 1..n {
                            p = super::motion::word_end(&self.buffer, p, big);
                        }
                        Some(MotionTarget {
                            pos: p,
                            kind: MotionKind::Inclusive,
                            vertical: false,
                        })
                    }
                    _ => self.eval_motion(m, count, true),
                };
                match target {
                    Some(t) => self.motion_range(m, t),
                    None => return,
                }
            }
        };
        self.apply_operator(op, range, reg);
    }

    fn motion_range(&self, motion: Motion, t: MotionTarget) -> Range {
        let buf = &self.buffer;
        let (s, e) = order(self.cursor, t.pos);
        match t.kind {
            MotionKind::Linewise => Range::lines(s.line, e.line),
            MotionKind::Inclusive => Range::chars(s, Pos::new(e.line, e.col + 1)),
            MotionKind::Exclusive => {
                let mut e = e;
                if e.line > s.line
                    && buf.line(e.line)[..e.col.min(buf.line_len(e.line))]
                        .iter()
                        .all(|c| c.is_whitespace())
                {
                    if matches!(motion, Motion::WordForward { .. }) {
                        // `dw` on the last word of a line stops at the line end.
                        e = Pos::new(e.line - 1, buf.line_len(e.line - 1));
                    } else if e.col == 0 {
                        if buf.line(s.line)[..s.col].iter().all(|c| c.is_whitespace()) {
                            return Range::lines(s.line, e.line - 1);
                        }
                        e = Pos::new(e.line - 1, buf.line_len(e.line - 1));
                    }
                }
                Range::chars(s, e)
            }
        }
    }

    fn range_register(&self, r: &Range) -> Register {
        if r.linewise {
            let text = (r.start.line..=r.end.line)
                .map(|l| self.buffer.line_string(l))
                .collect::<Vec<_>>()
                .join("\n");
            Register {
                text,
                linewise: true,
            }
        } else {
            Register {
                text: self.buffer.text_range(r.start, r.end),
                linewise: false,
            }
        }
    }

    pub(crate) fn apply_operator(&mut self, op: Operator, r: Range, reg: Option<char>) {
        match op {
            Operator::Yank => {
                self.yank_flash = Some(r);
                let content = self.range_register(&r);
                self.registers.set(reg, content, RegisterOp::Yank);
                if r.linewise {
                    if self.cursor.line != r.start.line {
                        self.cursor.line = r.start.line;
                    }
                } else {
                    self.cursor = r.start;
                }
            }
            Operator::Delete => {
                let content = self.range_register(&r);
                if r.linewise {
                    self.buffer.remove_lines(r.start.line, r.end.line);
                    let line = r.start.line.min(self.buffer.last_line());
                    self.cursor = Pos::new(line, self.buffer.first_non_blank(line));
                } else {
                    self.buffer.delete_range(r.start, r.end);
                    self.cursor = r.start;
                }
                self.registers.set(reg, content, RegisterOp::Delete);
            }
            Operator::Change => {
                let content = self.range_register(&r);
                if r.linewise {
                    let indent = if self.options.autoindent {
                        self.buffer.indent_of(r.start.line)
                    } else {
                        Vec::new()
                    };
                    let col = indent.len();
                    self.buffer.replace_line(r.start.line, indent);
                    if r.end.line > r.start.line {
                        self.buffer.remove_lines(r.start.line + 1, r.end.line);
                    }
                    self.cursor = Pos::new(r.start.line, col);
                } else {
                    self.buffer.delete_range(r.start, r.end);
                    self.cursor = r.start;
                }
                self.registers.set(reg, content, RegisterOp::Delete);
                self.begin_insert(1, false);
            }
            Operator::Indent | Operator::Outdent => {
                let last = if !r.linewise && r.end.col == 0 && r.end.line > r.start.line {
                    r.end.line - 1
                } else {
                    r.end.line
                };
                self.shift_lines(r.start.line, last, op == Operator::Indent);
                self.cursor = Pos::new(r.start.line, self.buffer.first_non_blank(r.start.line));
            }
            Operator::Lowercase | Operator::Uppercase | Operator::ToggleCase => {
                for line in r.start.line..=r.end.line {
                    let mut chars = self.buffer.line(line).to_vec();
                    let (from, to) = if r.linewise {
                        (0, chars.len())
                    } else {
                        let from = if line == r.start.line { r.start.col } else { 0 };
                        let to = if line == r.end.line {
                            r.end.col.min(chars.len())
                        } else {
                            chars.len()
                        };
                        (from, to)
                    };
                    for c in &mut chars[from.min(to)..to] {
                        *c = change_case(*c, op);
                    }
                    self.buffer.replace_line(line, chars);
                }
                if !r.linewise || self.cursor.line != r.start.line {
                    self.cursor = Pos::new(
                        r.start.line,
                        if r.linewise {
                            self.cursor.col
                        } else {
                            r.start.col
                        },
                    );
                }
            }
        }
    }

    pub(crate) fn shift_lines(&mut self, first: usize, last: usize, indent: bool) {
        let sw = self.options.shiftwidth.max(1);
        let unit = self.indent_unit();
        for line in first..=last.min(self.buffer.last_line()) {
            let mut chars = self.buffer.line(line).to_vec();
            if indent {
                if !chars.is_empty() {
                    chars.splice(0..0, unit.iter().copied());
                }
            } else if chars.first() == Some(&'\t') {
                chars.remove(0);
            } else {
                let n = chars.iter().take(sw).take_while(|c| **c == ' ').count();
                chars.drain(..n);
            }
            self.buffer.replace_line(line, chars);
        }
    }

    pub(crate) fn paste(&mut self, reg: Option<char>, before: bool, count: usize) {
        let Some(content) = self.registers.get(reg) else {
            self.set_error(format!("E353: Nothing in register {}", reg.unwrap_or('"')));
            return;
        };
        let cur = self.cursor;
        if content.linewise {
            let mut lines = Vec::new();
            for _ in 0..count {
                lines.extend(
                    content
                        .text
                        .split('\n')
                        .map(|l| l.chars().collect::<Vec<char>>()),
                );
            }
            let at = if before { cur.line } else { cur.line + 1 };
            self.buffer.insert_lines(at, lines);
            self.cursor = Pos::new(at, self.buffer.first_non_blank(at));
        } else {
            let text = content.text.repeat(count);
            let at = if before || self.buffer.line_len(cur.line) == 0 {
                cur
            } else {
                Pos::new(cur.line, cur.col + 1)
            };
            let end = self.buffer.insert_text(at, &text);
            self.cursor = if text.contains('\n') {
                at
            } else {
                Pos::new(end.line, end.col.saturating_sub(1))
            };
        }
        self.update_want_col();
    }

    pub(crate) fn replace_chars(&mut self, c: char, count: usize) {
        let cur = self.cursor;
        if cur.col + count > self.buffer.line_len(cur.line) {
            return;
        }
        if c == '\n' {
            self.buffer
                .delete_range(cur, Pos::new(cur.line, cur.col + count));
            self.buffer.insert_text(cur, "\n");
            self.cursor = Pos::new(cur.line + 1, 0);
            return;
        }
        for i in 0..count {
            self.buffer.set_char(Pos::new(cur.line, cur.col + i), c);
        }
        self.cursor.col += count - 1;
    }

    /// Join `joins` following lines onto `line`.
    pub(crate) fn join_lines(&mut self, line: usize, joins: usize, spaces: bool) {
        if line >= self.buffer.last_line() {
            return;
        }
        let mut col = 0;
        for _ in 0..joins {
            if line >= self.buffer.last_line() {
                break;
            }
            let mut current = self.buffer.line(line).to_vec();
            let next = self.buffer.line(line + 1);
            let next: Vec<char> = if spaces {
                next.iter()
                    .skip_while(|c| c.is_whitespace())
                    .copied()
                    .collect()
            } else {
                next.to_vec()
            };
            if spaces {
                while current.last().is_some_and(|c| c.is_whitespace()) {
                    current.pop();
                }
            }
            col = current.len();
            if spaces && !current.is_empty() && !next.is_empty() && next[0] != ')' {
                current.push(' ');
            }
            current.extend(next);
            self.buffer.replace_line(line, current);
            self.buffer.remove_lines(line + 1, line + 1);
        }
        self.cursor = Pos::new(line, col);
    }

    pub(crate) fn toggle_case_chars(&mut self, count: usize) {
        let cur = self.cursor;
        let len = self.buffer.line_len(cur.line);
        if len == 0 {
            return;
        }
        let end = (cur.col + count).min(len);
        for col in cur.col..end {
            let p = Pos::new(cur.line, col);
            if let Some(c) = self.buffer.char_at(p) {
                self.buffer
                    .set_char(p, change_case(c, Operator::ToggleCase));
            }
        }
        self.cursor.col = end.min(len - 1);
        self.update_want_col();
    }

    pub(crate) fn start_insert(&mut self, kind: InsertKind, count: usize) {
        let line = self.cursor.line;
        let len = self.buffer.line_len(line);
        match kind {
            InsertKind::Before => {}
            InsertKind::After => self.cursor.col = (self.cursor.col + 1).min(len),
            InsertKind::LineStart => {
                self.cursor.col = if self.buffer.is_blank_line(line) {
                    len
                } else {
                    self.buffer.first_non_blank(line)
                };
            }
            InsertKind::LineEnd => self.cursor.col = len,
            InsertKind::Column0 => self.cursor.col = 0,
            InsertKind::OpenBelow | InsertKind::OpenAbove => {
                self.open_line(kind == InsertKind::OpenBelow);
                self.begin_insert(count, true);
                return;
            }
        }
        self.begin_insert(count, false);
    }

    pub(crate) fn open_line(&mut self, below: bool) {
        let line = self.cursor.line;
        let mut indent = if self.options.autoindent {
            self.buffer.indent_of(line)
        } else {
            Vec::new()
        };
        let opens_block = below
            && self.options.autoindent
            && matches!(
                self.buffer
                    .line(line)
                    .iter()
                    .rev()
                    .find(|c| !c.is_whitespace()),
                Some('{' | '(' | '[')
            );
        if opens_block {
            indent.extend(self.indent_unit());
        }
        let at = if below { line + 1 } else { line };
        let col = indent.len();
        self.buffer.insert_lines(at, vec![indent]);
        self.cursor = Pos::new(at, col);
        if col > 0 {
            self.insert.autoindent_line = Some(at);
        }
    }

    pub(crate) fn scroll(&mut self, kind: Scroll, count: Option<usize>) {
        let rows = self.view_rows;
        let last = self.buffer.last_line();
        let n = count.unwrap_or(1);
        match kind {
            Scroll::HalfPageDown | Scroll::HalfPageUp => {
                let amount = count.unwrap_or((rows / 2).max(1));
                let down = kind == Scroll::HalfPageDown;
                if (down && self.cursor.line == last) || (!down && self.cursor.line == 0) {
                    return;
                }
                let delta = if down {
                    amount as isize
                } else {
                    -(amount as isize)
                };
                self.scroll_top = self.scroll_top.saturating_add_signed(delta).min(last);
                self.cursor.line = self.cursor.line.saturating_add_signed(delta).min(last);
                self.cursor.col = self.col_for_want(self.cursor.line);
            }
            Scroll::PageDown | Scroll::PageUp => {
                let amount = (rows.saturating_sub(2)).max(1) * n;
                if kind == Scroll::PageDown {
                    self.scroll_by(amount as isize);
                } else {
                    self.scroll_by(-(amount as isize));
                }
            }
            Scroll::LineDown => self.scroll_by(n as isize),
            Scroll::LineUp => self.scroll_by(-(n as isize)),
            Scroll::CursorTop | Scroll::CursorMiddle | Scroll::CursorBottom => {
                if let Some(c) = count {
                    self.cursor.line = c.saturating_sub(1).min(last);
                }
                let line = self.cursor.line;
                self.scroll_top = match kind {
                    Scroll::CursorTop => line.saturating_sub(self.scrolloff()),
                    Scroll::CursorMiddle => line.saturating_sub(rows / 2),
                    _ => (line + 1 + self.scrolloff()).saturating_sub(rows),
                };
            }
        }
    }

    pub(crate) fn search_word(&mut self, forward: bool, count: usize) {
        let line = self.buffer.line(self.cursor.line);
        let Some(start) = (self.cursor.col..line.len()).find(|&i| is_keyword(line[i])) else {
            self.set_error("E348: No string under cursor");
            return;
        };
        let mut s = start;
        while s > 0 && is_keyword(line[s - 1]) {
            s -= 1;
        }
        let mut e = start;
        while e < line.len() && is_keyword(line[e]) {
            e += 1;
        }
        let word: String = line[s..e].iter().collect();
        let escaped = regex::escape(&word);
        self.last_search = Some(LastSearch {
            pattern: format!("\\<{escaped}\\>"),
            forward,
        });
        // Start from the beginning of the word so the current one is skipped.
        self.cursor.col = s;
        if let Some(target) = self.eval_motion(Motion::SearchNext, Some(count), false) {
            self.move_to(Motion::SearchNext, target);
        }
    }

    pub(crate) fn increment(&mut self, delta: i64) {
        let line = self.buffer.line(self.cursor.line);
        let col = self.cursor.col;
        let Some(first_digit) = (col..line.len()).find(|&i| line[i].is_ascii_digit()) else {
            return;
        };
        let mut s = first_digit;
        while s > 0 && line[s - 1].is_ascii_digit() {
            s -= 1;
        }
        let mut e = first_digit;
        while e < line.len() && line[e].is_ascii_digit() {
            e += 1;
        }
        if s > 0 && line[s - 1] == '-' {
            s -= 1;
        }
        let text: String = line[s..e].iter().collect();
        let Ok(value) = text.parse::<i64>() else {
            return;
        };
        let new = value.saturating_add(delta).to_string();
        let start = Pos::new(self.cursor.line, s);
        self.buffer
            .delete_range(start, Pos::new(self.cursor.line, e));
        self.buffer.insert_text(start, &new);
        self.cursor = Pos::new(self.cursor.line, s + new.chars().count() - 1);
        self.update_want_col();
    }

    // ----- Visual mode ---------------------------------------------------------

    fn visual_range(&self, force_linewise: bool) -> Range {
        let (s, e) = order(self.visual_anchor, self.cursor);
        if force_linewise || self.mode == Mode::VisualLine {
            Range::lines(s.line, e.line)
        } else {
            Range::chars(s, Pos::new(e.line, e.col + 1))
        }
    }

    pub(crate) fn visual_operate(
        &mut self,
        op: Operator,
        linewise: bool,
        count: usize,
        reg: Option<char>,
    ) {
        let range = self.visual_range(linewise);
        self.exit_visual();
        if matches!(op, Operator::Indent | Operator::Outdent) {
            for _ in 0..count {
                self.apply_operator(op, range, reg);
            }
            return;
        }
        self.apply_operator(op, range, reg);
    }

    pub(crate) fn visual_select_object(&mut self, obj: TextObject, around: bool, count: usize) {
        let Some(r) = self.text_object(obj, around, count) else {
            return;
        };
        if r.linewise {
            self.visual_anchor = r.start;
            self.cursor = Pos::new(r.end.line, 0);
            self.mode = Mode::VisualLine;
        } else {
            self.visual_anchor = r.start;
            let mut end = r.end;
            if !super::motion::retreat(&self.buffer, &mut end) {
                end = r.start;
            }
            self.cursor = end.max(r.start);
        }
        self.update_want_col();
    }

    pub(crate) fn visual_replace(&mut self, c: char) {
        let r = self.visual_range(false);
        self.exit_visual();
        let (first, last) = (r.start.line, r.end.line);
        for line in first..=last {
            let len = self.buffer.line_len(line);
            let (from, to) = if r.linewise {
                (0, len)
            } else {
                (
                    if line == first { r.start.col } else { 0 },
                    if line == last {
                        r.end.col.min(len)
                    } else {
                        len
                    },
                )
            };
            let mut chars = self.buffer.line(line).to_vec();
            for ch in &mut chars[from.min(to)..to] {
                *ch = c;
            }
            self.buffer.replace_line(line, chars);
        }
        self.cursor = r.start;
    }

    pub(crate) fn visual_paste(&mut self, reg: Option<char>) {
        let Some(content) = self.registers.get(reg) else {
            self.set_error("E353: Nothing in register");
            self.exit_visual();
            return;
        };
        let r = self.visual_range(false);
        self.exit_visual();
        let replaced = self.range_register(&r);
        if r.linewise {
            let mut text = content.text.clone();
            if !content.linewise {
                text = text.trim_end_matches('\n').to_string();
            }
            let lines: Vec<Vec<char>> = text.split('\n').map(|l| l.chars().collect()).collect();
            self.buffer.insert_lines(r.end.line + 1, lines);
            self.buffer.remove_lines(r.start.line, r.end.line);
            self.cursor = Pos::new(r.start.line, self.buffer.first_non_blank(r.start.line));
        } else {
            self.buffer.delete_range(r.start, r.end);
            let text = if content.linewise {
                format!("\n{}\n", content.text)
            } else {
                content.text.clone()
            };
            let end = self.buffer.insert_text(r.start, &text);
            self.cursor = if content.linewise {
                Pos::new(r.start.line + 1, 0)
            } else {
                Pos::new(end.line, end.col.saturating_sub(1))
            };
        }
        self.registers.set(None, replaced, RegisterOp::Delete);
    }
}

fn change_case(c: char, op: Operator) -> char {
    let single = |mut it: Box<dyn Iterator<Item = char>>| match (it.next(), it.next()) {
        (Some(x), None) => x,
        _ => c,
    };
    match op {
        Operator::Lowercase => single(Box::new(c.to_lowercase())),
        Operator::Uppercase => single(Box::new(c.to_uppercase())),
        _ if c.is_lowercase() => single(Box::new(c.to_uppercase())),
        _ if c.is_uppercase() => single(Box::new(c.to_lowercase())),
        _ => c,
    }
}
