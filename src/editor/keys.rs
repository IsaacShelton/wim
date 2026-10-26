//! Toolkit-independent key representation used by the editor core.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Esc,
    Enter,
    Backspace,
    Delete,
    Tab,
    /// Shift+Tab.
    BackTab,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyInput {
    pub key: Key,
    pub ctrl: bool,
    /// Option on macOS.
    pub alt: bool,
}

impl KeyInput {
    pub fn new(key: Key, ctrl: bool) -> Self {
        Self {
            key,
            ctrl,
            alt: false,
        }
        .normalized()
    }

    pub fn plain(key: Key) -> Self {
        Self {
            key,
            ctrl: false,
            alt: false,
        }
    }

    pub fn alt(key: Key) -> Self {
        Self {
            key,
            ctrl: false,
            alt: true,
        }
    }

    pub fn ch(c: char) -> Self {
        Self::plain(Key::Char(c))
    }

    pub fn ctrl(c: char) -> Self {
        Self::new(Key::Char(c), true)
    }

    /// Map terminal aliases onto their canonical keys. Like Neovim, `<C-h>`,
    /// `<C-j>` and `<C-i>` stay distinct from `<BS>`, `<CR>` and `<Tab>` so
    /// they can be mapped.
    fn normalized(self) -> Self {
        match (self.key, self.ctrl) {
            (Key::Char('['), true) | (Key::Char('c'), true) => Self::plain(Key::Esc),
            (Key::Char('m'), true) => Self::plain(Key::Enter),
            (Key::Char(c), true) => Self {
                key: Key::Char(c.to_ascii_lowercase()),
                ctrl: true,
                alt: false,
            },
            _ => self,
        }
    }

    /// The typed character, if this is an unmodified printable key.
    pub fn char(&self) -> Option<char> {
        match self.key {
            Key::Char(c) if !self.ctrl && !self.alt => Some(c),
            _ => None,
        }
    }

    pub fn is(&self, c: char) -> bool {
        self.char() == Some(c)
    }
}

impl fmt::Display for KeyInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.ctrl
            && let Key::Char(c) = self.key
        {
            return write!(f, "^{}", c.to_ascii_uppercase());
        }
        if self.alt {
            write!(f, "M-")?;
        }
        match self.key {
            Key::Char(c) => write!(f, "{c}"),
            Key::Esc => write!(f, "<Esc>"),
            Key::Enter => write!(f, "<CR>"),
            Key::Backspace => write!(f, "<BS>"),
            Key::Delete => write!(f, "<Del>"),
            Key::Tab => write!(f, "<Tab>"),
            Key::BackTab => write!(f, "<S-Tab>"),
            Key::Left => write!(f, "<Left>"),
            Key::Right => write!(f, "<Right>"),
            Key::Up => write!(f, "<Up>"),
            Key::Down => write!(f, "<Down>"),
            Key::Home => write!(f, "<Home>"),
            Key::End => write!(f, "<End>"),
            Key::PageUp => write!(f, "<PageUp>"),
            Key::PageDown => write!(f, "<PageDown>"),
        }
    }
}

/// Parse Vim key notation such as `dw`, `<Esc>`, `<C-r>` or `<CR>`.
pub fn parse_keys(s: &str) -> Vec<KeyInput> {
    let mut out = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<' {
            let rest: String = chars.clone().take_while(|&c| c != '>').collect();
            let closed = chars.clone().nth(rest.chars().count()) == Some('>');
            if closed && let Some(key) = parse_named(&rest) {
                for _ in 0..=rest.chars().count() {
                    chars.next();
                }
                out.push(key);
                continue;
            }
        }
        out.push(KeyInput::ch(c));
    }
    out
}

fn parse_named(name: &str) -> Option<KeyInput> {
    let lower = name.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("c-") {
        let mut it = rest.chars();
        let c = it.next()?;
        return it.next().is_none().then(|| KeyInput::ctrl(c));
    }
    if let Some(rest) = lower
        .strip_prefix("m-")
        .or_else(|| lower.strip_prefix("a-"))
    {
        let inner = parse_named(rest).map(|k| k.key).or_else(|| {
            let mut it = rest.chars();
            let c = it.next()?;
            it.next().is_none().then_some(Key::Char(c))
        })?;
        return Some(KeyInput::alt(inner));
    }
    let key = match lower.as_str() {
        "esc" => Key::Esc,
        "cr" | "enter" | "return" => Key::Enter,
        "bs" => Key::Backspace,
        "del" => Key::Delete,
        "tab" => Key::Tab,
        "s-tab" => Key::BackTab,
        "left" => Key::Left,
        "right" => Key::Right,
        "up" => Key::Up,
        "down" => Key::Down,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "space" => Key::Char(' '),
        "lt" => Key::Char('<'),
        _ => return None,
    };
    Some(KeyInput::plain(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_notation() {
        let keys = parse_keys("d<C-r><Esc>a<lt><x>");
        assert_eq!(
            keys,
            vec![
                KeyInput::ch('d'),
                KeyInput::ctrl('r'),
                KeyInput::plain(Key::Esc),
                KeyInput::ch('a'),
                KeyInput::ch('<'),
                KeyInput::ch('<'),
                KeyInput::ch('x'),
                KeyInput::ch('>'),
            ]
        );
    }
}
