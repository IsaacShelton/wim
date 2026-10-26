//! Vim registers, including the system clipboard (`"+` and `"*`).

use std::collections::HashMap;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Register {
    /// For linewise registers this holds the lines joined by `\n`, without a
    /// trailing newline.
    pub text: String,
    pub linewise: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RegisterOp {
    Yank,
    Delete,
}

#[derive(Default)]
pub struct Registers {
    map: HashMap<char, Register>,
    clipboard: Option<arboard::Clipboard>,
    /// Mirror the unnamed register to the system clipboard (`clipboard=unnamed`).
    pub use_system_clipboard: bool,
}

pub fn is_valid_name(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '"' | '+' | '*' | '_' | '-')
}

impl Registers {
    pub fn get(&mut self, name: Option<char>) -> Option<Register> {
        let name = name.unwrap_or('"');
        if (name == '+' || name == '*' || (name == '"' && self.use_system_clipboard))
            && let Some(reg) = self.read_clipboard()
        {
            return Some(reg);
        }
        self.map.get(&name.to_ascii_lowercase()).cloned()
    }

    pub fn set(&mut self, name: Option<char>, reg: Register, op: RegisterOp) {
        match name {
            Some('_') => return,
            Some('+') | Some('*') => self.write_clipboard(&reg),
            Some(c) if c.is_ascii_uppercase() => {
                let lower = c.to_ascii_lowercase();
                let merged = match self.map.remove(&lower) {
                    Some(mut old) => {
                        if old.linewise || reg.linewise {
                            old.text.push('\n');
                        }
                        old.text.push_str(&reg.text);
                        old.linewise |= reg.linewise;
                        old
                    }
                    None => reg,
                };
                self.map.insert(lower, merged.clone());
                self.map.insert('"', merged);
                return;
            }
            Some(c) if c != '"' => {
                self.map.insert(c, reg.clone());
            }
            _ => {
                match op {
                    RegisterOp::Yank => {
                        self.map.insert('0', reg.clone());
                    }
                    RegisterOp::Delete if reg.linewise || reg.text.contains('\n') => {
                        for i in (1..9).rev() {
                            let from = char::from(b'0' + i);
                            if let Some(r) = self.map.remove(&from) {
                                self.map.insert(char::from(b'1' + i), r);
                            }
                        }
                        self.map.insert('1', reg.clone());
                    }
                    RegisterOp::Delete => {
                        self.map.insert('-', reg.clone());
                    }
                }
                if self.use_system_clipboard {
                    self.write_clipboard(&reg);
                }
            }
        }
        self.map.insert('"', reg);
    }

    fn clipboard(&mut self) -> Option<&mut arboard::Clipboard> {
        if self.clipboard.is_none() {
            self.clipboard = arboard::Clipboard::new().ok();
        }
        self.clipboard.as_mut()
    }

    fn read_clipboard(&mut self) -> Option<Register> {
        let text = self.clipboard()?.get_text().ok()?;
        let text = text.replace("\r\n", "\n");
        Some(match text.strip_suffix('\n') {
            Some(stripped) => Register {
                text: stripped.to_string(),
                linewise: true,
            },
            None => Register {
                text,
                linewise: false,
            },
        })
    }

    fn write_clipboard(&mut self, reg: &Register) {
        let mut text = reg.text.clone();
        if reg.linewise {
            text.push('\n');
        }
        if let Some(cb) = self.clipboard() {
            let _ = cb.set_text(text);
        }
    }
}
