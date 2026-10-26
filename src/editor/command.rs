//! Parsing of Normal and Visual mode key sequences into commands.
//!
//! The editor accumulates keys until [`parse`] reports a complete command (or
//! an invalid sequence), which keeps multi-key grammar such as `"a3d2w`,
//! `ci(` or `gUiw` in one place.

use super::keys::{Key, KeyInput};
use super::registers::is_valid_name;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operator {
    Delete,
    Change,
    Yank,
    Indent,
    Outdent,
    Lowercase,
    Uppercase,
    ToggleCase,
}

impl Operator {
    /// The key that, when repeated, applies the operator linewise (`dd`, `g~~`).
    fn line_key(self) -> char {
        match self {
            Operator::Delete => 'd',
            Operator::Change => 'c',
            Operator::Yank => 'y',
            Operator::Indent => '>',
            Operator::Outdent => '<',
            Operator::Lowercase => 'u',
            Operator::Uppercase => 'U',
            Operator::ToggleCase => '~',
        }
    }

    fn is_g_prefixed(self) -> bool {
        matches!(
            self,
            Operator::Lowercase | Operator::Uppercase | Operator::ToggleCase
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FindKind {
    /// `f`
    To,
    /// `t`
    Till,
    /// `F`
    BackTo,
    /// `T`
    BackTill,
}

impl FindKind {
    pub fn forward(self) -> bool {
        matches!(self, FindKind::To | FindKind::Till)
    }

    pub fn till(self) -> bool {
        matches!(self, FindKind::Till | FindKind::BackTill)
    }

    pub fn reversed(self) -> FindKind {
        match self {
            FindKind::To => FindKind::BackTo,
            FindKind::Till => FindKind::BackTill,
            FindKind::BackTo => FindKind::To,
            FindKind::BackTill => FindKind::Till,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    Left,
    Right,
    Up,
    Down,
    WordForward { big: bool },
    WordBackward { big: bool },
    WordEnd { big: bool },
    WordEndBackward { big: bool },
    LineStart,
    FirstNonBlank,
    LineEnd,
    LastNonBlank,
    Column,
    FileStart,
    FileEnd,
    NextLineStart,
    PrevLineStart,
    CurrentLineStart,
    Find { kind: FindKind, ch: char },
    RepeatFind,
    RepeatFindReverse,
    MatchPair,
    ParagraphForward,
    ParagraphBackward,
    ScreenTop,
    ScreenMiddle,
    ScreenBottom,
    SearchNext,
    SearchPrev,
    Mark { name: char, exact: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextObject {
    Word { big: bool },
    Quote(char),
    Pair(char, char),
    Paragraph,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Motion(Motion),
    Object {
        obj: TextObject,
        around: bool,
    },
    /// The operator key was doubled (`dd`, `>>`): operate on whole lines.
    Line,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InsertKind {
    Before,
    After,
    LineStart,
    LineEnd,
    Column0,
    OpenBelow,
    OpenAbove,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scroll {
    HalfPageDown,
    HalfPageUp,
    PageDown,
    PageUp,
    LineDown,
    LineUp,
    CursorTop,
    CursorMiddle,
    CursorBottom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Move(Motion),
    Operate(Operator, Target),
    Insert(InsertKind),
    Paste { before: bool },
    ReplaceChar(char),
    Join { spaces: bool },
    Undo,
    Redo,
    Repeat,
    ToggleCaseChar,
    Visual,
    VisualLine,
    Reselect,
    ReplaceMode,
    CmdLine,
    Search { forward: bool },
    SearchWord { forward: bool },
    Scroll(Scroll),
    SetMark(char),
    Increment(i64),
    WriteQuit,
    QuitForce,
    FileInfo,
    // Visual mode only.
    VisualOp(Operator),
    VisualLinewiseOp(Operator),
    VisualObject { obj: TextObject, around: bool },
    VisualSwap,
    VisualReplace(char),
    VisualPaste,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Command {
    pub register: Option<char>,
    pub count: Option<usize>,
    pub action: Action,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parse {
    Incomplete,
    Invalid,
    Done(Command),
}

pub fn parse(keys: &[KeyInput], visual: bool) -> Parse {
    let mut k = Keys { keys, i: 0 };
    match parse_command(&mut k, visual) {
        Ok(cmd) => Parse::Done(cmd),
        Err(p) => p,
    }
}

struct Keys<'a> {
    keys: &'a [KeyInput],
    i: usize,
}

impl Keys<'_> {
    fn next(&mut self) -> Result<KeyInput, Parse> {
        let key = self.peek()?;
        self.i += 1;
        Ok(key)
    }

    fn peek(&self) -> Result<KeyInput, Parse> {
        self.keys.get(self.i).copied().ok_or(Parse::Incomplete)
    }

    /// The literal character argument of commands such as `f`, `r` and `m`.
    fn next_char(&mut self) -> Result<char, Parse> {
        let key = self.next()?;
        match key.key {
            _ if key.ctrl => Err(Parse::Invalid),
            Key::Char(c) => Ok(c),
            Key::Tab => Ok('\t'),
            Key::Enter => Ok('\n'),
            _ => Err(Parse::Invalid),
        }
    }

    fn count(&mut self) -> Result<Option<usize>, Parse> {
        let mut n: Option<usize> = None;
        loop {
            match self.peek()?.char() {
                Some(c @ '0'..='9') if n.is_some() || c != '0' => {
                    let digit = c as usize - '0' as usize;
                    n = Some(
                        n.unwrap_or(0)
                            .saturating_mul(10)
                            .saturating_add(digit)
                            .min(99_999),
                    );
                    self.i += 1;
                }
                _ => return Ok(n),
            }
        }
    }
}

fn multiply(a: Option<usize>, b: Option<usize>) -> Option<usize> {
    match (a, b) {
        (None, None) => None,
        _ => Some((a.unwrap_or(1) * b.unwrap_or(1)).min(99_999)),
    }
}

fn parse_command(k: &mut Keys, visual: bool) -> Result<Command, Parse> {
    let mut count = k.count()?;
    let mut register = None;
    if k.peek()?.is('"') {
        k.i += 1;
        let name = k.next_char()?;
        if !is_valid_name(name) {
            return Err(Parse::Invalid);
        }
        register = Some(name);
        count = multiply(count, k.count()?);
    }
    let key = k.next()?;
    let action = if visual {
        parse_visual(k, key)?
    } else {
        parse_normal(k, key, &mut count)?
    };
    Ok(Command {
        register,
        count,
        action,
    })
}

fn parse_scroll(key: KeyInput) -> Option<Action> {
    if key.ctrl {
        let scroll = match key.key {
            Key::Char('d') => Scroll::HalfPageDown,
            Key::Char('u') => Scroll::HalfPageUp,
            Key::Char('f') => Scroll::PageDown,
            Key::Char('b') => Scroll::PageUp,
            Key::Char('e') => Scroll::LineDown,
            Key::Char('y') => Scroll::LineUp,
            _ => return None,
        };
        return Some(Action::Scroll(scroll));
    }
    match key.key {
        Key::PageDown => Some(Action::Scroll(Scroll::PageDown)),
        Key::PageUp => Some(Action::Scroll(Scroll::PageUp)),
        _ => None,
    }
}

fn parse_normal(k: &mut Keys, key: KeyInput, count: &mut Option<usize>) -> Result<Action, Parse> {
    if let Some(m) = parse_motion(k, key)? {
        return Ok(Action::Move(m));
    }
    if let Some(action) = parse_scroll(key) {
        return Ok(action);
    }
    if key.ctrl {
        return match key.key {
            Key::Char('r') => Ok(Action::Redo),
            Key::Char('a') => Ok(Action::Increment(1)),
            Key::Char('x') => Ok(Action::Increment(-1)),
            Key::Char('g') => Ok(Action::FileInfo),
            _ => Err(Parse::Invalid),
        };
    }
    if key.key == Key::Delete {
        return Ok(Action::Operate(
            Operator::Delete,
            Target::Motion(Motion::Right),
        ));
    }
    let Some(c) = key.char() else {
        return Err(Parse::Invalid);
    };
    use Operator::*;
    let action = match c {
        'd' => parse_operator(k, Delete, count)?,
        'c' => parse_operator(k, Change, count)?,
        'y' => parse_operator(k, Yank, count)?,
        '>' => parse_operator(k, Indent, count)?,
        '<' => parse_operator(k, Outdent, count)?,
        'x' => Action::Operate(Delete, Target::Motion(Motion::Right)),
        'X' => Action::Operate(Delete, Target::Motion(Motion::Left)),
        's' => Action::Operate(Change, Target::Motion(Motion::Right)),
        'S' => Action::Operate(Change, Target::Line),
        'D' => Action::Operate(Delete, Target::Motion(Motion::LineEnd)),
        'C' => Action::Operate(Change, Target::Motion(Motion::LineEnd)),
        'Y' => Action::Operate(Yank, Target::Line),
        'p' => Action::Paste { before: false },
        'P' => Action::Paste { before: true },
        'r' => Action::ReplaceChar(k.next_char()?),
        'J' => Action::Join { spaces: true },
        'u' => Action::Undo,
        '.' => Action::Repeat,
        '~' => Action::ToggleCaseChar,
        'i' => Action::Insert(InsertKind::Before),
        'a' => Action::Insert(InsertKind::After),
        'I' => Action::Insert(InsertKind::LineStart),
        'A' => Action::Insert(InsertKind::LineEnd),
        'o' => Action::Insert(InsertKind::OpenBelow),
        'O' => Action::Insert(InsertKind::OpenAbove),
        'v' => Action::Visual,
        'V' => Action::VisualLine,
        'R' => Action::ReplaceMode,
        ':' => Action::CmdLine,
        '/' => Action::Search { forward: true },
        '?' => Action::Search { forward: false },
        '*' => Action::SearchWord { forward: true },
        '#' => Action::SearchWord { forward: false },
        'm' => {
            let name = k.next_char()?;
            if !name.is_ascii_alphabetic() {
                return Err(Parse::Invalid);
            }
            Action::SetMark(name)
        }
        'z' => {
            let next = k.next()?;
            let scroll = match next.key {
                Key::Char('z') | Key::Char('.') => Scroll::CursorMiddle,
                Key::Char('t') | Key::Enter => Scroll::CursorTop,
                Key::Char('b') | Key::Char('-') => Scroll::CursorBottom,
                _ => return Err(Parse::Invalid),
            };
            Action::Scroll(scroll)
        }
        'Z' => match k.next_char()? {
            'Z' => Action::WriteQuit,
            'Q' => Action::QuitForce,
            _ => return Err(Parse::Invalid),
        },
        'g' => match k.next_char()? {
            '~' => parse_operator(k, ToggleCase, count)?,
            'u' => parse_operator(k, Lowercase, count)?,
            'U' => parse_operator(k, Uppercase, count)?,
            'v' => Action::Reselect,
            'J' => Action::Join { spaces: false },
            'I' => Action::Insert(InsertKind::Column0),
            _ => return Err(Parse::Invalid),
        },
        _ => return Err(Parse::Invalid),
    };
    Ok(action)
}

fn parse_operator(k: &mut Keys, op: Operator, count: &mut Option<usize>) -> Result<Action, Parse> {
    *count = multiply(*count, k.count()?);
    let key = k.next()?;
    let line_key = op.line_key();
    if key.is(line_key) {
        return Ok(Action::Operate(op, Target::Line));
    }
    if op.is_g_prefixed() && key.is('g') && k.peek()?.is(line_key) {
        k.i += 1;
        return Ok(Action::Operate(op, Target::Line));
    }
    if key.is('i') || key.is('a') {
        let obj = text_object(k.next_char()?).ok_or(Parse::Invalid)?;
        return Ok(Action::Operate(
            op,
            Target::Object {
                obj,
                around: key.is('a'),
            },
        ));
    }
    match parse_motion(k, key)? {
        Some(m) => Ok(Action::Operate(op, Target::Motion(m))),
        None => Err(Parse::Invalid),
    }
}

fn parse_visual(k: &mut Keys, key: KeyInput) -> Result<Action, Parse> {
    if let Some(m) = parse_motion(k, key)? {
        return Ok(Action::Move(m));
    }
    if let Some(action) = parse_scroll(key) {
        return Ok(action);
    }
    if key.ctrl {
        return Err(Parse::Invalid);
    }
    if key.key == Key::Delete {
        return Ok(Action::VisualOp(Operator::Delete));
    }
    let Some(c) = key.char() else {
        return Err(Parse::Invalid);
    };
    use Operator::*;
    let action = match c {
        'd' | 'x' => Action::VisualOp(Delete),
        'c' | 's' => Action::VisualOp(Change),
        'y' => Action::VisualOp(Yank),
        '>' => Action::VisualOp(Indent),
        '<' => Action::VisualOp(Outdent),
        '~' => Action::VisualOp(ToggleCase),
        'u' => Action::VisualOp(Lowercase),
        'U' => Action::VisualOp(Uppercase),
        'D' | 'X' => Action::VisualLinewiseOp(Delete),
        'C' | 'S' | 'R' => Action::VisualLinewiseOp(Change),
        'Y' => Action::VisualLinewiseOp(Yank),
        'J' => Action::Join { spaces: true },
        'p' | 'P' => Action::VisualPaste,
        'r' => Action::VisualReplace(k.next_char()?),
        'o' | 'O' => Action::VisualSwap,
        'i' | 'a' => {
            let obj = text_object(k.next_char()?).ok_or(Parse::Invalid)?;
            Action::VisualObject {
                obj,
                around: c == 'a',
            }
        }
        'v' => Action::Visual,
        'V' => Action::VisualLine,
        ':' => Action::CmdLine,
        '/' => Action::Search { forward: true },
        '?' => Action::Search { forward: false },
        'g' => match k.next_char()? {
            'J' => Action::Join { spaces: false },
            '~' => Action::VisualOp(ToggleCase),
            'u' => Action::VisualOp(Lowercase),
            'U' => Action::VisualOp(Uppercase),
            _ => return Err(Parse::Invalid),
        },
        _ => return Err(Parse::Invalid),
    };
    Ok(action)
}

fn text_object(c: char) -> Option<TextObject> {
    Some(match c {
        'w' => TextObject::Word { big: false },
        'W' => TextObject::Word { big: true },
        'p' => TextObject::Paragraph,
        '"' | '\'' | '`' => TextObject::Quote(c),
        '(' | ')' | 'b' => TextObject::Pair('(', ')'),
        '{' | '}' | 'B' => TextObject::Pair('{', '}'),
        '[' | ']' => TextObject::Pair('[', ']'),
        '<' | '>' => TextObject::Pair('<', '>'),
        _ => return None,
    })
}

/// Parse a motion starting with `key`. Returns `Ok(None)` without consuming
/// further keys when `key` does not start a motion.
fn parse_motion(k: &mut Keys, key: KeyInput) -> Result<Option<Motion>, Parse> {
    use Motion::*;
    if key.ctrl {
        return Ok(match key.key {
            Key::Char('n') => Some(Down),
            Key::Char('p') => Some(Up),
            _ => None,
        });
    }
    let c = match key.key {
        Key::Left | Key::Backspace => return Ok(Some(Left)),
        Key::Right => return Ok(Some(Right)),
        Key::Up => return Ok(Some(Up)),
        Key::Down => return Ok(Some(Down)),
        Key::Home => return Ok(Some(LineStart)),
        Key::End => return Ok(Some(LineEnd)),
        Key::Enter => return Ok(Some(NextLineStart)),
        Key::Char(c) => c,
        _ => return Ok(None),
    };
    let motion = match c {
        'h' => Left,
        'l' | ' ' => Right,
        'j' => Down,
        'k' => Up,
        'w' => WordForward { big: false },
        'W' => WordForward { big: true },
        'b' => WordBackward { big: false },
        'B' => WordBackward { big: true },
        'e' => WordEnd { big: false },
        'E' => WordEnd { big: true },
        '0' => LineStart,
        '^' => FirstNonBlank,
        '$' => LineEnd,
        '|' => Column,
        'G' => FileEnd,
        '+' => NextLineStart,
        '-' => PrevLineStart,
        '_' => CurrentLineStart,
        'f' | 'F' | 't' | 'T' => {
            let kind = match c {
                'f' => FindKind::To,
                'F' => FindKind::BackTo,
                't' => FindKind::Till,
                _ => FindKind::BackTill,
            };
            Find {
                kind,
                ch: k.next_char()?,
            }
        }
        ';' => RepeatFind,
        ',' => RepeatFindReverse,
        '%' => MatchPair,
        '}' => ParagraphForward,
        '{' => ParagraphBackward,
        'H' => ScreenTop,
        'M' => ScreenMiddle,
        'L' => ScreenBottom,
        'n' => SearchNext,
        'N' => SearchPrev,
        '\'' | '`' => Mark {
            name: k.next_char()?,
            exact: c == '`',
        },
        'g' => {
            let motion = match k.peek()?.char() {
                Some('g') => FileStart,
                Some('e') => WordEndBackward { big: false },
                Some('E') => WordEndBackward { big: true },
                Some('_') => LastNonBlank,
                Some('0') => LineStart,
                Some('j') => Down,
                Some('k') => Up,
                _ => return Ok(None),
            };
            k.i += 1;
            motion
        }
        _ => return Ok(None),
    };
    Ok(Some(motion))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::keys::parse_keys;

    fn done(s: &str) -> Command {
        match parse(&parse_keys(s), false) {
            Parse::Done(c) => c,
            other => panic!("{s}: {other:?}"),
        }
    }

    #[test]
    fn counts_multiply() {
        let c = done("2d3w");
        assert_eq!(c.count, Some(6));
        assert_eq!(
            c.action,
            Action::Operate(
                Operator::Delete,
                Target::Motion(Motion::WordForward { big: false })
            )
        );
    }

    #[test]
    fn registers_and_objects() {
        let c = done("\"ayi(");
        assert_eq!(c.register, Some('a'));
        assert_eq!(
            c.action,
            Action::Operate(
                Operator::Yank,
                Target::Object {
                    obj: TextObject::Pair('(', ')'),
                    around: false
                }
            )
        );
    }

    #[test]
    fn incomplete_and_invalid() {
        assert_eq!(parse(&parse_keys("d"), false), Parse::Incomplete);
        assert_eq!(parse(&parse_keys("2"), false), Parse::Incomplete);
        assert_eq!(parse(&parse_keys("g"), false), Parse::Incomplete);
        assert_eq!(parse(&parse_keys("dQ"), false), Parse::Invalid);
    }

    #[test]
    fn g_operators_double() {
        assert_eq!(
            done("gUU").action,
            Action::Operate(Operator::Uppercase, Target::Line)
        );
        assert_eq!(
            done("gUgU").action,
            Action::Operate(Operator::Uppercase, Target::Line)
        );
        assert_eq!(
            done("gUgg").action,
            Action::Operate(Operator::Uppercase, Target::Motion(Motion::FileStart))
        );
    }
}
