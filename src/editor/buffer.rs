//! The text buffer: a list of lines, each stored as a vector of chars so that
//! columns can be indexed directly.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pos {
    pub line: usize,
    pub col: usize,
}

impl Pos {
    pub fn new(line: usize, col: usize) -> Self {
        Self { line, col }
    }
}

#[derive(Clone, Debug)]
pub struct Buffer {
    lines: Vec<Vec<char>>,
    /// Identifies the current content. Every mutation takes a fresh id from
    /// `next_version`; restoring a snapshot restores its id, so "is this the
    /// saved content?" can be answered by comparing ids.
    version: u64,
    next_version: u64,
}

impl Default for Buffer {
    fn default() -> Self {
        Self::new()
    }
}

impl Buffer {
    pub fn new() -> Self {
        Self {
            lines: vec![Vec::new()],
            version: 0,
            next_version: 1,
        }
    }

    pub fn from_text(text: &str) -> Self {
        let text = text.strip_suffix('\n').unwrap_or(text);
        let lines = text
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l).chars().collect())
            .collect();
        Self {
            lines,
            version: 0,
            next_version: 1,
        }
    }

    /// The buffer contents as a file would store them (with a final newline).
    pub fn to_file_text(&self) -> String {
        let mut s = self.text();
        s.push('\n');
        s
    }

    pub fn text(&self) -> String {
        self.lines
            .iter()
            .map(|l| l.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    fn touch(&mut self) {
        self.version = self.next_version;
        self.next_version += 1;
    }

    pub fn snapshot(&self) -> (Vec<Vec<char>>, u64) {
        (self.lines.clone(), self.version)
    }

    pub fn restore(&mut self, lines: Vec<Vec<char>>, version: u64) {
        self.lines = lines;
        self.version = version;
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    pub fn last_line(&self) -> usize {
        self.lines.len() - 1
    }

    pub fn line(&self, i: usize) -> &[char] {
        &self.lines[i]
    }

    pub fn line_len(&self, i: usize) -> usize {
        self.lines[i].len()
    }

    pub fn line_string(&self, i: usize) -> String {
        self.lines[i].iter().collect()
    }

    pub fn char_at(&self, p: Pos) -> Option<char> {
        self.lines.get(p.line).and_then(|l| l.get(p.col)).copied()
    }

    pub fn is_blank_line(&self, i: usize) -> bool {
        self.lines[i].iter().all(|c| c.is_whitespace())
    }

    pub fn first_non_blank(&self, i: usize) -> usize {
        let line = &self.lines[i];
        line.iter()
            .position(|c| !c.is_whitespace())
            .unwrap_or(line.len().saturating_sub(1))
    }

    pub fn indent_of(&self, i: usize) -> Vec<char> {
        self.lines[i]
            .iter()
            .take_while(|c| **c == ' ' || **c == '\t')
            .copied()
            .collect()
    }

    /// The position just past the last character of the buffer.
    pub fn end_pos(&self) -> Pos {
        Pos::new(self.last_line(), self.line_len(self.last_line()))
    }

    fn clamp(&self, p: Pos) -> Pos {
        if p.line >= self.lines.len() {
            return self.end_pos();
        }
        Pos::new(p.line, p.col.min(self.lines[p.line].len()))
    }

    /// Text between `start` (inclusive) and `end` (exclusive). A column equal
    /// to the line length addresses the line break.
    pub fn text_range(&self, start: Pos, end: Pos) -> String {
        let (start, end) = (self.clamp(start), self.clamp(end));
        if start >= end {
            return String::new();
        }
        if start.line == end.line {
            return self.lines[start.line][start.col..end.col].iter().collect();
        }
        let mut s: String = self.lines[start.line][start.col..].iter().collect();
        for l in start.line + 1..end.line {
            s.push('\n');
            s.extend(self.lines[l].iter());
        }
        s.push('\n');
        s.extend(self.lines[end.line][..end.col].iter());
        s
    }

    pub fn delete_range(&mut self, start: Pos, end: Pos) -> String {
        let (start, end) = (self.clamp(start), self.clamp(end));
        let text = self.text_range(start, end);
        if start >= end {
            return text;
        }
        let tail = self.lines[end.line][end.col..].to_vec();
        self.lines[start.line].truncate(start.col);
        self.lines[start.line].extend(tail);
        self.lines.drain(start.line + 1..=end.line);
        self.touch();
        text
    }

    /// Insert `text` at `pos`, returning the position just after it.
    pub fn insert_text(&mut self, pos: Pos, text: &str) -> Pos {
        let pos = self.clamp(pos);
        if text.is_empty() {
            return pos;
        }
        let tail = self.lines[pos.line].split_off(pos.col);
        let mut parts = text.split('\n');
        self.lines[pos.line].extend(parts.next().unwrap_or("").chars());
        let new_lines: Vec<Vec<char>> = parts.map(|p| p.chars().collect()).collect();
        let end_line = pos.line + new_lines.len();
        self.lines.splice(pos.line + 1..pos.line + 1, new_lines);
        let end = Pos::new(end_line, self.lines[end_line].len());
        self.lines[end_line].extend(tail);
        self.touch();
        end
    }

    pub fn insert_char(&mut self, pos: Pos, c: char) {
        let pos = self.clamp(pos);
        self.lines[pos.line].insert(pos.col, c);
        self.touch();
    }

    pub fn set_char(&mut self, pos: Pos, c: char) {
        if self.lines[pos.line][pos.col] != c {
            self.lines[pos.line][pos.col] = c;
            self.touch();
        }
    }

    pub fn insert_lines(&mut self, at: usize, lines: Vec<Vec<char>>) {
        let at = at.min(self.lines.len());
        self.lines.splice(at..at, lines);
        self.touch();
    }

    /// Remove lines `first..=last`. The buffer always keeps at least one line.
    pub fn remove_lines(&mut self, first: usize, last: usize) -> Vec<Vec<char>> {
        let last = last.min(self.last_line());
        let removed: Vec<_> = self.lines.drain(first..=last).collect();
        if self.lines.is_empty() {
            self.lines.push(Vec::new());
        }
        self.touch();
        removed
    }

    pub fn replace_line(&mut self, i: usize, line: Vec<char>) {
        if self.lines[i] != line {
            self.lines[i] = line;
            self.touch();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_delete_round_trip() {
        let mut b = Buffer::from_text("hello\nworld\n");
        let end = b.insert_text(Pos::new(0, 2), "XX\nYY");
        assert_eq!(end, Pos::new(1, 2));
        assert_eq!(b.text(), "heXX\nYYllo\nworld");
        let removed = b.delete_range(Pos::new(0, 2), end);
        assert_eq!(removed, "XX\nYY");
        assert_eq!(b.text(), "hello\nworld");
    }

    #[test]
    fn delete_across_line_break() {
        let mut b = Buffer::from_text("ab\ncd");
        b.delete_range(Pos::new(0, 2), Pos::new(1, 0));
        assert_eq!(b.text(), "abcd");
    }
}
