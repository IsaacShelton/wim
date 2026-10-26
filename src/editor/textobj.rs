//! Text objects (`iw`, `a"`, `i(`, `ap`, ...).

use super::Editor;
use super::buffer::Pos;
use super::command::TextObject;
use super::motion::{advance, char_class, retreat};
use super::ops::Range;

impl Editor {
    pub(crate) fn text_object(&self, obj: TextObject, around: bool, count: usize) -> Option<Range> {
        match obj {
            TextObject::Word { big } => self.word_object(big, around, count),
            TextObject::Quote(q) => self.quote_object(q, around),
            TextObject::Pair(open, close) => self.pair_object(open, close, around, count),
            TextObject::Paragraph => self.paragraph_object(around, count),
        }
    }

    fn word_object(&self, big: bool, around: bool, count: usize) -> Option<Range> {
        let line_no = self.cursor.line;
        let line = self.buffer.line(line_no);
        if line.is_empty() {
            return None;
        }
        let len = line.len();
        let cls = |i: usize| char_class(line[i], big);
        let col = self.cursor.col.min(len - 1);
        let run_end = |mut e: usize| {
            let c = cls(e);
            while e < len && cls(e) == c {
                e += 1;
            }
            e
        };
        let start_cls = cls(col);
        let mut s = col;
        while s > 0 && cls(s - 1) == start_cls {
            s -= 1;
        }
        let mut e = run_end(col);
        for _ in 1..count {
            if e >= len {
                break;
            }
            e = run_end(e);
        }
        if around {
            if start_cls != 0 {
                if e < len && cls(e) == 0 {
                    e = run_end(e);
                } else {
                    while s > 0 && cls(s - 1) == 0 {
                        s -= 1;
                    }
                }
            } else if e < len {
                e = run_end(e);
            }
        }
        Some(Range::chars(Pos::new(line_no, s), Pos::new(line_no, e)))
    }

    fn quote_object(&self, q: char, around: bool) -> Option<Range> {
        let line_no = self.cursor.line;
        let line = self.buffer.line(line_no);
        let col = self.cursor.col;
        let quotes: Vec<usize> = (0..line.len())
            .filter(|&i| line[i] == q && (i == 0 || line[i - 1] != '\\'))
            .collect();
        let (a, b) = if let Some(idx) = quotes.iter().position(|&i| i == col) {
            if idx % 2 == 0 {
                (col, *quotes.get(idx + 1)?)
            } else {
                (quotes[idx - 1], col)
            }
        } else {
            let before = quotes.iter().rev().find(|&&i| i < col);
            let after = quotes.iter().find(|&&i| i > col);
            match (before, after) {
                (Some(&a), Some(&b)) => (a, b),
                (None, Some(&a)) => (a, *quotes.iter().find(|&&i| i > a)?),
                _ => return None,
            }
        };
        if !around {
            return Some(Range::chars(Pos::new(line_no, a + 1), Pos::new(line_no, b)));
        }
        let (mut s, mut e) = (a, b + 1);
        if e < line.len() && line[e].is_whitespace() {
            while e < line.len() && line[e].is_whitespace() {
                e += 1;
            }
        } else {
            while s > 0 && line[s - 1].is_whitespace() {
                s -= 1;
            }
        }
        Some(Range::chars(Pos::new(line_no, s), Pos::new(line_no, e)))
    }

    fn pair_object(&self, open: char, close: char, around: bool, count: usize) -> Option<Range> {
        let buf = &self.buffer;
        let mut from = self.cursor;
        let mut open_pos = None;
        for _ in 0..count {
            let mut p = from;
            let mut depth = 0usize;
            loop {
                match buf.char_at(p) {
                    Some(c) if c == open => {
                        if depth == 0 {
                            break;
                        }
                        depth -= 1;
                    }
                    Some(c) if c == close && p != self.cursor => depth += 1,
                    _ => {}
                }
                if !retreat(buf, &mut p) {
                    return None;
                }
            }
            open_pos = Some(p);
            from = p;
            if !retreat(buf, &mut from) {
                break;
            }
        }
        let open_pos = open_pos?;
        let mut close_pos = open_pos;
        let mut depth = 0usize;
        loop {
            if !advance(buf, &mut close_pos) {
                return None;
            }
            match buf.char_at(close_pos) {
                Some(c) if c == open => depth += 1,
                Some(c) if c == close => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                _ => {}
            }
        }
        if around {
            return Some(Range::chars(
                open_pos,
                Pos::new(close_pos.line, close_pos.col + 1),
            ));
        }
        let mut start = Pos::new(open_pos.line, open_pos.col + 1);
        let mut end = close_pos;
        // A block whose braces sit on their own lines is operated on linewise.
        if start.col == buf.line_len(start.line) && start.line < end.line {
            start = Pos::new(start.line + 1, 0);
        }
        if buf.line(end.line)[..end.col]
            .iter()
            .all(|c| c.is_whitespace())
            && end.line > start.line
        {
            end = Pos::new(end.line, 0);
            if start.col == 0 {
                return Some(Range::lines(start.line, end.line - 1));
            }
            end = Pos::new(end.line - 1, buf.line_len(end.line - 1));
        }
        Some(Range::chars(start, end))
    }

    fn paragraph_object(&self, around: bool, count: usize) -> Option<Range> {
        let buf = &self.buffer;
        let last = buf.last_line();
        let line = self.cursor.line;
        let blank = |l: usize| buf.is_blank_line(l);
        let kind = blank(line);
        let mut s = line;
        while s > 0 && blank(s - 1) == kind {
            s -= 1;
        }
        let run_end = |mut e: usize| {
            let k = blank(e);
            while e < last && blank(e + 1) == k {
                e += 1;
            }
            e
        };
        let mut e = run_end(line);
        let extra = if around { 1 } else { 0 };
        for _ in 1..count + extra {
            if e >= last {
                if around {
                    // No trailing blank lines: take the preceding ones instead.
                    while s > 0 && blank(s - 1) != kind {
                        s -= 1;
                    }
                }
                break;
            }
            e = run_end(e + 1);
        }
        Some(Range::lines(s, e))
    }
}
