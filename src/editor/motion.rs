//! Cursor motions.

use super::buffer::{Buffer, Pos};
use super::command::{FindKind, Motion};
use super::{Editor, search};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MotionKind {
    Exclusive,
    Inclusive,
    Linewise,
}

#[derive(Clone, Copy, Debug)]
pub struct MotionTarget {
    pub pos: Pos,
    pub kind: MotionKind,
    /// Vertical motions keep the remembered column.
    pub vertical: bool,
}

impl MotionTarget {
    fn new(pos: Pos, kind: MotionKind) -> Self {
        Self {
            pos,
            kind,
            vertical: false,
        }
    }
}

/// Character classes for word motions: blank, punctuation, keyword.
pub(crate) fn char_class(c: char, big: bool) -> u8 {
    if c.is_whitespace() {
        0
    } else if big || !is_keyword(c) {
        1
    } else {
        2
    }
}

pub(crate) fn is_keyword(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Class at `p`; the end-of-line position counts as blank.
fn class_at(buf: &Buffer, p: Pos, big: bool) -> u8 {
    buf.char_at(p).map_or(0, |c| char_class(c, big))
}

/// Step forward one position, treating each line break as a position.
pub(crate) fn advance(buf: &Buffer, p: &mut Pos) -> bool {
    if p.col < buf.line_len(p.line) {
        p.col += 1;
        true
    } else if p.line < buf.last_line() {
        *p = Pos::new(p.line + 1, 0);
        true
    } else {
        false
    }
}

pub(crate) fn retreat(buf: &Buffer, p: &mut Pos) -> bool {
    if p.col > 0 {
        p.col -= 1;
        true
    } else if p.line > 0 {
        p.line -= 1;
        p.col = buf.line_len(p.line);
        true
    } else {
        false
    }
}

fn is_empty_line_start(buf: &Buffer, p: Pos) -> bool {
    p.col == 0 && buf.line_len(p.line) == 0
}

pub(crate) fn next_word_start(buf: &Buffer, start: Pos, big: bool) -> Pos {
    let mut p = start;
    let cls = class_at(buf, p, big);
    if cls != 0 {
        while class_at(buf, p, big) == cls {
            if !advance(buf, &mut p) {
                return p;
            }
        }
    }
    loop {
        if class_at(buf, p, big) != 0 || (is_empty_line_start(buf, p) && p.line != start.line) {
            return p;
        }
        if !advance(buf, &mut p) {
            return p;
        }
    }
}

pub(crate) fn prev_word_start(buf: &Buffer, start: Pos, big: bool) -> Pos {
    let mut p = start;
    if !retreat(buf, &mut p) {
        return p;
    }
    while class_at(buf, p, big) == 0 {
        if is_empty_line_start(buf, p) || !retreat(buf, &mut p) {
            return p;
        }
    }
    let cls = class_at(buf, p, big);
    loop {
        let mut q = p;
        if !retreat(buf, &mut q) || class_at(buf, q, big) != cls {
            return p;
        }
        p = q;
    }
}

pub(crate) fn word_end(buf: &Buffer, start: Pos, big: bool) -> Pos {
    let mut p = start;
    if !advance(buf, &mut p) {
        return p;
    }
    while class_at(buf, p, big) == 0 {
        if !advance(buf, &mut p) {
            return p;
        }
    }
    end_of_run(buf, p, big)
}

/// The last position of the run of same-class characters containing `p`.
pub(crate) fn end_of_run(buf: &Buffer, mut p: Pos, big: bool) -> Pos {
    let cls = class_at(buf, p, big);
    loop {
        let mut q = p;
        if !advance(buf, &mut q) || class_at(buf, q, big) != cls || q.line != p.line {
            return p;
        }
        p = q;
    }
}

fn prev_word_end(buf: &Buffer, start: Pos, big: bool) -> Pos {
    let mut p = start;
    let cls = class_at(buf, p, big);
    if cls != 0 {
        while class_at(buf, p, big) == cls {
            if !retreat(buf, &mut p) {
                return p;
            }
        }
    }
    loop {
        if class_at(buf, p, big) != 0 || (is_empty_line_start(buf, p) && p != start) {
            return p;
        }
        if !retreat(buf, &mut p) {
            return p;
        }
    }
}

fn find_in_line(
    line: &[char],
    mut col: usize,
    kind: FindKind,
    ch: char,
    count: usize,
    repeat: bool,
) -> Option<usize> {
    for i in 0..count {
        // When repeating `t`/`T`, skip the character we are already next to.
        let skip = usize::from(kind.till() && (i > 0 || repeat));
        if kind.forward() {
            let found = (col + 1 + skip..line.len()).find(|&j| line[j] == ch)?;
            col = if kind.till() { found - 1 } else { found };
        } else {
            let found = (0..col.saturating_sub(skip))
                .rev()
                .find(|&j| line[j] == ch)?;
            col = if kind.till() { found + 1 } else { found };
        }
    }
    Some(col)
}

pub(crate) fn matching_pair(buf: &Buffer, from: Pos) -> Option<Pos> {
    let line = buf.line(from.line);
    let (col, c) = (from.col..line.len())
        .map(|j| (j, line[j]))
        .find(|(_, c)| "()[]{}".contains(*c))?;
    let (open, close, forward) = match c {
        '(' => ('(', ')', true),
        '[' => ('[', ']', true),
        '{' => ('{', '}', true),
        ')' => ('(', ')', false),
        ']' => ('[', ']', false),
        _ => ('{', '}', false),
    };
    let mut p = Pos::new(from.line, col);
    let mut depth = 0usize;
    loop {
        let moved = if forward {
            advance(buf, &mut p)
        } else {
            retreat(buf, &mut p)
        };
        if !moved {
            return None;
        }
        match buf.char_at(p) {
            Some(x) if x == (if forward { open } else { close }) => depth += 1,
            Some(x) if x == (if forward { close } else { open }) => {
                if depth == 0 {
                    return Some(p);
                }
                depth -= 1;
            }
            _ => {}
        }
    }
}

impl Editor {
    /// Evaluate a motion from the cursor. `for_op` is set when the motion is
    /// the target of an operator, which allows positions past the last char.
    pub(crate) fn eval_motion(
        &mut self,
        motion: Motion,
        count: Option<usize>,
        for_op: bool,
    ) -> Option<MotionTarget> {
        use MotionKind::*;
        if let Motion::Mark { name, .. } = motion
            && name.is_ascii_uppercase()
            && !self.enter_mark_buffer(name, for_op)
        {
            self.set_error("E20: Mark not set");
            return None;
        }
        let n = count.unwrap_or(1);
        let buf = &self.buffer;
        let cur = self.cursor;
        let last = buf.last_line();
        let len = buf.line_len(cur.line);
        let first_non_blank = |line: usize| Pos::new(line, buf.first_non_blank(line));

        let target = match motion {
            Motion::Left => {
                MotionTarget::new(Pos::new(cur.line, cur.col.saturating_sub(n)), Exclusive)
            }
            Motion::Right => {
                let max = if for_op || self.mode.is_insert() {
                    len
                } else {
                    len.saturating_sub(1)
                };
                MotionTarget::new(Pos::new(cur.line, (cur.col + n).min(max)), Exclusive)
            }
            Motion::Up | Motion::Down => {
                let line = if motion == Motion::Up {
                    cur.line.saturating_sub(n)
                } else {
                    (cur.line + n).min(last)
                };
                if line == cur.line {
                    return None;
                }
                let pos = Pos::new(line, self.col_for_want(line));
                MotionTarget {
                    pos,
                    kind: Linewise,
                    vertical: true,
                }
            }
            Motion::WordForward { big } => {
                let mut p = cur;
                for _ in 0..n {
                    p = next_word_start(buf, p, big);
                }
                MotionTarget::new(p, Exclusive)
            }
            Motion::WordBackward { big } => {
                let mut p = cur;
                for _ in 0..n {
                    p = prev_word_start(buf, p, big);
                }
                MotionTarget::new(p, Exclusive)
            }
            Motion::WordEnd { big } => {
                let mut p = cur;
                for _ in 0..n {
                    p = word_end(buf, p, big);
                }
                MotionTarget::new(p, Inclusive)
            }
            Motion::WordEndBackward { big } => {
                let mut p = cur;
                for _ in 0..n {
                    p = prev_word_end(buf, p, big);
                }
                MotionTarget::new(p, Inclusive)
            }
            Motion::LineStart => MotionTarget::new(Pos::new(cur.line, 0), Exclusive),
            Motion::FirstNonBlank => MotionTarget::new(first_non_blank(cur.line), Exclusive),
            Motion::LineEnd => {
                let line = (cur.line + n - 1).min(last);
                let col = buf.line_len(line).saturating_sub(1);
                MotionTarget::new(Pos::new(line, col), Inclusive)
            }
            Motion::LastNonBlank => {
                let line = (cur.line + n - 1).min(last);
                let col = buf
                    .line(line)
                    .iter()
                    .rposition(|c| !c.is_whitespace())
                    .unwrap_or(0);
                MotionTarget::new(Pos::new(line, col), Inclusive)
            }
            Motion::Column => {
                let col = self
                    .col_from_display(cur.line, n - 1)
                    .min(len.saturating_sub(1));
                MotionTarget::new(Pos::new(cur.line, col), Exclusive)
            }
            Motion::FileStart | Motion::FileEnd => {
                let default = if motion == Motion::FileStart { 0 } else { last };
                let line = count.map_or(default, |c| c.saturating_sub(1).min(last));
                MotionTarget::new(first_non_blank(line), Linewise)
            }
            Motion::NextLineStart | Motion::PrevLineStart | Motion::CurrentLineStart => {
                let line = match motion {
                    Motion::NextLineStart => cur.line + n,
                    Motion::PrevLineStart => cur.line.checked_sub(n)?,
                    _ => cur.line + n - 1,
                };
                if line > last {
                    return None;
                }
                MotionTarget::new(first_non_blank(line), Linewise)
            }
            Motion::Find { kind, ch } => {
                self.last_find = Some((kind, ch));
                return self.find_char(kind, ch, n, false);
            }
            Motion::RepeatFind | Motion::RepeatFindReverse => {
                let (kind, ch) = self.last_find?;
                let kind = if motion == Motion::RepeatFind {
                    kind
                } else {
                    kind.reversed()
                };
                return self.find_char(kind, ch, n, true);
            }
            Motion::MatchPair => match count {
                Some(pct) => {
                    let line = ((pct.min(100) * buf.line_count()).div_ceil(100)).saturating_sub(1);
                    MotionTarget::new(first_non_blank(line), Linewise)
                }
                None => MotionTarget::new(matching_pair(buf, cur)?, Inclusive),
            },
            Motion::ParagraphForward => {
                let mut line = cur.line;
                for _ in 0..n {
                    line += 1;
                    while line <= last && buf.line_len(line) == 0 {
                        line += 1;
                    }
                    while line <= last && buf.line_len(line) != 0 {
                        line += 1;
                    }
                    if line > last {
                        break;
                    }
                }
                let pos = if line > last {
                    buf.end_pos()
                } else {
                    Pos::new(line, 0)
                };
                MotionTarget::new(pos, Exclusive)
            }
            Motion::ParagraphBackward => {
                let mut line = cur.line as isize;
                for _ in 0..n {
                    line -= 1;
                    while line >= 0 && buf.line_len(line as usize) == 0 {
                        line -= 1;
                    }
                    while line >= 0 && buf.line_len(line as usize) != 0 {
                        line -= 1;
                    }
                    if line < 0 {
                        break;
                    }
                }
                MotionTarget::new(Pos::new(line.max(0) as usize, 0), Exclusive)
            }
            Motion::ScreenTop | Motion::ScreenMiddle | Motion::ScreenBottom => {
                let so = self.scrolloff();
                let top = self.scroll_top;
                let bottom = (top + self.view_rows - 1).min(last);
                let line = match motion {
                    Motion::ScreenTop => {
                        let min = if top == 0 { 0 } else { so };
                        (top + (n - 1).max(min)).min(bottom)
                    }
                    Motion::ScreenBottom => {
                        let min = if bottom == last { 0 } else { so };
                        bottom.saturating_sub((n - 1).max(min)).max(top)
                    }
                    _ => top + (bottom - top) / 2,
                };
                MotionTarget::new(first_non_blank(line), Linewise)
            }
            Motion::SearchNext | Motion::SearchPrev => {
                return self.search_motion(motion == Motion::SearchNext, n);
            }
            Motion::Unmatched { ch } => {
                let forward = matches!(ch, '}' | ')');
                let (open, close) = if matches!(ch, '{' | '}') {
                    ('{', '}')
                } else {
                    ('(', ')')
                };
                let mut p = cur;
                for _ in 0..n {
                    p = find_unmatched(buf, p, open, close, forward)?;
                }
                MotionTarget::new(p, Exclusive)
            }
            Motion::Mark { name, exact } => {
                let name = if name == '`' { '\'' } else { name };
                let Some(pos) = self.mark_pos(name) else {
                    self.set_error("E20: Mark not set");
                    return None;
                };
                let line = pos.line.min(last);
                if exact {
                    let col = pos.col.min(buf.line_len(line).saturating_sub(1));
                    MotionTarget::new(Pos::new(line, col), Exclusive)
                } else {
                    MotionTarget::new(first_non_blank(line), Linewise)
                }
            }
        };
        Some(target)
    }

    /// Make the buffer holding uppercase mark `name` active. Operators
    /// can't span buffers, so for them the mark must be in this buffer.
    fn enter_mark_buffer(&mut self, name: char, for_op: bool) -> bool {
        let Some(mark) = self.global_marks.get(&name).cloned() else {
            return false;
        };
        if mark.buffer_id == self.buffer_id() {
            return true;
        }
        if for_op {
            return false;
        }
        if !self.switch_to_buffer_quietly(mark.buffer_id) {
            let Some(path) = mark.path else {
                return false;
            };
            self.open_file(&path);
        }
        let id = self.buffer_id();
        if let Some(m) = self.global_marks.get_mut(&name) {
            m.buffer_id = id;
        }
        true
    }

    fn mark_pos(&self, name: char) -> Option<Pos> {
        if name.is_ascii_uppercase() {
            self.global_marks.get(&name).map(|m| m.pos)
        } else {
            self.marks.get(&name).copied()
        }
    }

    fn find_char(
        &mut self,
        kind: FindKind,
        ch: char,
        count: usize,
        repeat: bool,
    ) -> Option<MotionTarget> {
        let line = self.buffer.line(self.cursor.line);
        let col = find_in_line(line, self.cursor.col, kind, ch, count, repeat)?;
        let kind = if kind.forward() {
            MotionKind::Inclusive
        } else {
            MotionKind::Exclusive
        };
        Some(MotionTarget::new(Pos::new(self.cursor.line, col), kind))
    }

    fn search_motion(&mut self, same_direction: bool, count: usize) -> Option<MotionTarget> {
        let Some(last) = self.last_search.clone() else {
            self.set_error("E35: No previous regular expression");
            return None;
        };
        let Some(re) = self.regex_for(&last.pattern) else {
            self.set_error(format!("E486: Invalid pattern: {}", last.pattern));
            return None;
        };
        let forward = last.forward == same_direction;
        let mut pos = self.cursor;
        let mut wrapped = false;
        for _ in 0..count {
            match search::find(&self.buffer, &re, pos, forward) {
                Some((p, w)) => {
                    pos = p;
                    wrapped |= w;
                }
                None => {
                    self.set_error(format!("E486: Pattern not found: {}", last.pattern));
                    return None;
                }
            }
        }
        self.hlsearch_active = true;
        let prompt = if last.forward { '/' } else { '?' };
        if wrapped {
            let text = if forward {
                "search hit BOTTOM, continuing at TOP"
            } else {
                "search hit TOP, continuing at BOTTOM"
            };
            self.set_error(text);
        } else {
            self.set_message(format!("{prompt}{}", last.pattern));
        }
        Some(MotionTarget::new(pos, MotionKind::Exclusive))
    }

    /// Move the cursor to a motion target (outside of an operator).
    pub(crate) fn move_to(&mut self, motion: Motion, target: MotionTarget) {
        if is_jump(motion) && target.pos.line != self.cursor.line {
            self.marks.insert('\'', self.cursor);
        }
        self.cursor = target.pos;
        self.clamp_cursor();
        if motion == Motion::LineEnd {
            self.want_col = usize::MAX;
        } else if !target.vertical {
            self.update_want_col();
        }
    }
}

fn is_jump(m: Motion) -> bool {
    matches!(
        m,
        Motion::FileStart
            | Motion::FileEnd
            | Motion::SearchNext
            | Motion::SearchPrev
            | Motion::MatchPair
            | Motion::Mark { .. }
            | Motion::ParagraphForward
            | Motion::ParagraphBackward
            | Motion::ScreenTop
            | Motion::ScreenMiddle
            | Motion::ScreenBottom
    )
}

/// The next (or previous) bracket that is not matched between it and `from`
/// (`]}`, `[{`, `])`, `[(`).
fn find_unmatched(buf: &Buffer, from: Pos, open: char, close: char, forward: bool) -> Option<Pos> {
    let (same, target) = if forward {
        (open, close)
    } else {
        (close, open)
    };
    let mut p = from;
    let mut depth = 0usize;
    loop {
        let moved = if forward {
            advance(buf, &mut p)
        } else {
            retreat(buf, &mut p)
        };
        if !moved {
            return None;
        }
        match buf.char_at(p) {
            Some(c) if c == same => depth += 1,
            Some(c) if c == target => {
                if depth == 0 {
                    return Some(p);
                }
                depth -= 1;
            }
            _ => {}
        }
    }
}

/// Option+Left in macOS text fields: back over non-word characters, then to
/// the start of the word before them.
pub(crate) fn mac_word_left(buf: &Buffer, start: Pos) -> Pos {
    let is_word_before = |p: Pos| {
        let mut q = p;
        retreat(buf, &mut q) && buf.char_at(q).is_some_and(is_keyword)
    };
    let mut p = start;
    while !is_word_before(p) {
        if !retreat(buf, &mut p) {
            return p;
        }
    }
    while is_word_before(p) {
        retreat(buf, &mut p);
    }
    p
}

/// Option+Right in macOS text fields: over non-word characters, then to the
/// end of the following word.
pub(crate) fn mac_word_right(buf: &Buffer, start: Pos) -> Pos {
    let mut p = start;
    while !buf.char_at(p).is_some_and(is_keyword) {
        if !advance(buf, &mut p) {
            return p;
        }
    }
    while buf.char_at(p).is_some_and(is_keyword) {
        advance(buf, &mut p);
    }
    p
}
