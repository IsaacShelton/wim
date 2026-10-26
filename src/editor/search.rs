//! Pattern search. Vim's "magic" regex syntax is translated to the `regex`
//! crate's syntax so that patterns like `\<foo\>` and `\(a\|b\)` behave as
//! Vim users expect.

use regex::{Regex, RegexBuilder};

use super::buffer::{Buffer, Pos};

pub fn compile(pattern: &str, ignorecase: bool, smartcase: bool) -> Result<Regex, regex::Error> {
    let (translated, case_override) = translate(pattern);
    let insensitive = case_override
        .unwrap_or_else(|| ignorecase && !(smartcase && pattern.chars().any(|c| c.is_uppercase())));
    RegexBuilder::new(&translated)
        .case_insensitive(insensitive)
        .build()
}

/// Translate a Vim pattern. Returns the Rust regex and an explicit case
/// sensitivity request (`\c` / `\C`) if present.
fn translate(pattern: &str) -> (String, Option<bool>) {
    let mut out = String::new();
    let mut very_magic = false;
    let mut case = None;
    let mut in_count_brace = false;
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let Some(n) = chars.next() else {
                out.push_str("\\\\");
                break;
            };
            match n {
                'v' => very_magic = true,
                'V' | 'm' | 'M' => very_magic = false,
                'c' => case = Some(true),
                'C' => case = Some(false),
                '<' | '>' => out.push_str("\\b"),
                '(' | ')' | '|' | '+' | '{' | '}' if !very_magic => {
                    out.push(n);
                    in_count_brace = n == '{';
                }
                '=' | '?' if !very_magic => out.push('?'),
                _ => {
                    out.push('\\');
                    out.push(n);
                }
            }
        } else if very_magic {
            match c {
                '<' | '>' => out.push_str("\\b"),
                '=' => out.push('?'),
                _ => out.push(c),
            }
        } else if c == '}' && in_count_brace {
            out.push('}');
            in_count_brace = false;
        } else if "()|+?{}".contains(c) {
            out.push('\\');
            out.push(c);
        } else {
            out.push(c);
        }
    }
    (out, case)
}

/// Translate a Vim substitution replacement (`&`, `\1`) to `regex` syntax.
pub fn translate_replacement(rep: &str) -> String {
    let mut out = String::new();
    let mut chars = rep.chars();
    while let Some(c) = chars.next() {
        match c {
            '$' => out.push_str("$$"),
            '&' => out.push_str("${0}"),
            '\\' => match chars.next() {
                Some(d @ '0'..='9') => out.push_str(&format!("${{{d}}}")),
                Some('n') | Some('r') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            },
            _ => out.push(c),
        }
    }
    out
}

/// All matches in a line, as `(start, end)` char columns.
pub fn line_matches(re: &Regex, line: &[char]) -> Vec<(usize, usize)> {
    let s: String = line.iter().collect();
    if s.is_ascii() {
        return re.find_iter(&s).map(|m| (m.start(), m.end())).collect();
    }
    let offsets: Vec<usize> = s.char_indices().map(|(b, _)| b).collect();
    let to_col = |byte: usize| offsets.partition_point(|&b| b < byte);
    re.find_iter(&s)
        .map(|m| (to_col(m.start()), to_col(m.end())))
        .collect()
}

/// Find the next match strictly after (or before) `from`. Returns the match
/// start and whether the search wrapped around the buffer.
pub fn find(buf: &Buffer, re: &Regex, from: Pos, forward: bool) -> Option<(Pos, bool)> {
    let n = buf.line_count();
    if forward {
        for i in 0..=n {
            let line = (from.line + i) % n;
            let wrapped = from.line + i >= n;
            let hit = line_matches(re, buf.line(line))
                .into_iter()
                .map(|(s, _)| s)
                .find(|&s| i > 0 || s > from.col);
            if let Some(col) = hit {
                return Some((Pos::new(line, col), wrapped));
            }
        }
    } else {
        for i in 0..=n {
            let line = (from.line + n * 2 - i) % n;
            let wrapped = i > from.line;
            let hit = line_matches(re, buf.line(line))
                .into_iter()
                .map(|(s, _)| s)
                .filter(|&s| i > 0 || s < from.col)
                .next_back();
            if let Some(col) = hit {
                return Some((Pos::new(line, col), wrapped));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_magic() {
        assert_eq!(translate(r"\<foo\>").0, r"\bfoo\b");
        assert_eq!(translate(r"\(a\|b\)+").0, r"(a|b)\+");
        assert_eq!(translate(r"a\{2,3}").0, r"a{2,3}");
        assert_eq!(translate(r"\v(a|b)+").0, r"(a|b)+");
        assert_eq!(translate(r"foo\c").1, Some(true));
    }

    #[test]
    fn finds_with_wrap() {
        let buf = Buffer::from_text("foo\nbar\nfoo");
        let re = compile("foo", false, false).unwrap();
        assert_eq!(
            find(&buf, &re, Pos::new(0, 0), true),
            Some((Pos::new(2, 0), false))
        );
        assert_eq!(
            find(&buf, &re, Pos::new(2, 0), true),
            Some((Pos::new(0, 0), true))
        );
        assert_eq!(
            find(&buf, &re, Pos::new(2, 0), false),
            Some((Pos::new(0, 0), false))
        );
        assert_eq!(
            find(&buf, &re, Pos::new(0, 0), false),
            Some((Pos::new(2, 0), true))
        );
    }

    #[test]
    fn replacement() {
        assert_eq!(translate_replacement(r"<\1>&$"), "<${1}>${0}$$");
    }
}
