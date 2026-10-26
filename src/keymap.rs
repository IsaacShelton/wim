//! User key mappings, translated from `~/.config/nvim/init.lua` (leader `,`,
//! `timeoutlen` 300ms). Mappings to Neovim plugins Wim doesn't have
//! (Telescope, LSP, gitsigns, spider) are left out.

use std::time::Duration;

use crate::editor::keys::{KeyInput, parse_keys};

/// How long to wait for the rest of an ambiguous mapping (`timeoutlen`).
pub const TIMEOUT: Duration = Duration::from_millis(300);

const LEADER: &str = ",";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MapMode {
    Normal,
    Visual,
    Insert,
}

/// Actions handled by the window rather than the editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    WindowLeft,
    WindowRight,
    WindowUp,
    WindowDown,
    ToggleTree,
    /// Read one more character and insert it before the cursor.
    InsertCharBefore,
    /// Read one more character and insert it after the cursor.
    InsertCharAfter,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rhs {
    /// Keys fed to the editor without further mapping (`noremap`).
    Keys(Vec<KeyInput>),
    Command(Command),
}

impl Rhs {
    /// Whether this mapping makes sense while the file tree has focus: window
    /// commands and `:` commands do, editing keys don't.
    pub fn works_in_tree(&self) -> bool {
        match self {
            Rhs::Command(c) => !matches!(c, Command::InsertCharBefore | Command::InsertCharAfter),
            Rhs::Keys(keys) => keys.first().is_some_and(|k| k.is(':')),
        }
    }
}

struct Mapping {
    modes: &'static [MapMode],
    lhs: Vec<KeyInput>,
    rhs: Rhs,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Lookup<'a> {
    None,
    /// `keys` start one or more longer mappings.
    Prefix,
    /// `keys` are a complete mapping; `ambiguous` if they also start another.
    Exact {
        rhs: &'a Rhs,
        ambiguous: bool,
    },
}

pub struct Keymap {
    maps: Vec<Mapping>,
}

impl Keymap {
    pub fn from_neovim_config() -> Self {
        use Command::*;
        use MapMode::*;
        const N: &[MapMode] = &[Normal];
        const NV: &[MapMode] = &[Normal, Visual];
        const V: &[MapMode] = &[Visual];
        const I: &[MapMode] = &[Insert];
        let keys = |s: &str| Rhs::Keys(parse_keys(s));
        let maps: Vec<(&'static [MapMode], &str, Rhs)> = vec![
            // Insert a single character before/after the cursor (Option+c/d).
            (N, "ç", Rhs::Command(InsertCharBefore)),
            (N, "∂", Rhs::Command(InsertCharAfter)),
            // Jump to / place global marks (Option+a/r/s/t, Option+Shift+…).
            (N, "å", keys("'Azz")),
            (N, "®", keys("'Rzz")),
            (N, "ß", keys("'Szz")),
            (N, "†", keys("'Tzz")),
            (N, "Å", keys("mA")),
            (N, "‰", keys("mR")),
            (N, "Í", keys("mS")),
            (N, "ˇ", keys("mT")),
            // Writing and quitting.
            (N, "<leader>;", keys(":w<CR>")),
            (N, "<leader>:", keys(":wqa<CR>")),
            (N, "<leader>o", keys(":w<CR>")),
            (N, "<leader>'", keys(":w<CR>")),
            (N, "<leader>v", keys(":q<CR>")),
            (N, "<leader>V", keys(":q!<CR>")),
            // Paragraph motions on Option+j/k; outermost block with [f / ]f.
            (NV, "∆", keys("}")),
            (NV, "˚", keys("{")),
            (NV, "[f", keys(&"[{".repeat(12))),
            (NV, "]f", keys(&"]}".repeat(12))),
            // Insert-mode cursor movement.
            (I, "<C-l>", keys("<Right>")),
            (I, "<C-h>", keys("<Left>")),
            (I, "<C-k>", keys("<Up>")),
            (I, "<C-j>", keys("<Down>")),
            // Window navigation.
            (N, "<C-h>", Rhs::Command(WindowLeft)),
            (N, "<C-l>", Rhs::Command(WindowRight)),
            (N, "<C-j>", Rhs::Command(WindowDown)),
            (N, "<C-k>", Rhs::Command(WindowUp)),
            // Buffers.
            (N, "<Tab>", keys(":bnext<CR>")),
            (N, "<S-Tab>", keys(":bprev<CR>")),
            (N, "<leader>x", keys(":bd<CR>")),
            (N, "<leader>X", keys(":%bd<CR>")),
            (N, "<leader>K", keys(":bonly<CR>")),
            // Paste the last yank rather than the last delete.
            (NV, "<leader>p", keys("\"0p")),
            (NV, "<leader>P", keys("\"0P")),
            (NV, "<leader>d", keys("dd")),
            // Move lines with Option+Shift+j/k.
            (V, "Ô", keys(":m '>+1<CR>gv")),
            (V, "\u{f8ff}", keys(":m '<-2<CR>gv")),
            (N, "Ô", keys("V")),
            (N, "\u{f8ff}", keys("V")),
            (N, "<C-n>", Rhs::Command(ToggleTree)),
        ];
        let maps = maps
            .into_iter()
            .map(|(modes, lhs, rhs)| Mapping {
                modes,
                lhs: parse_keys(&lhs.replace("<leader>", LEADER)),
                rhs,
            })
            .collect();
        Self { maps }
    }

    pub fn lookup(&self, mode: MapMode, keys: &[KeyInput], in_tree: bool) -> Lookup<'_> {
        let mut exact = None;
        let mut longer = false;
        let candidates = self
            .maps
            .iter()
            .filter(|m| m.modes.contains(&mode) && (!in_tree || m.rhs.works_in_tree()));
        for m in candidates {
            if m.lhs == keys {
                exact = Some(&m.rhs);
            } else if m.lhs.starts_with(keys) {
                longer = true;
            }
        }
        match exact {
            Some(rhs) => Lookup::Exact {
                rhs,
                ambiguous: longer,
            },
            None if longer => Lookup::Prefix,
            None => Lookup::None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leader_mappings() {
        let map = Keymap::from_neovim_config();
        let k = parse_keys;
        assert_eq!(map.lookup(MapMode::Normal, &k(","), false), Lookup::Prefix);
        assert_eq!(
            map.lookup(MapMode::Normal, &k(",;"), false),
            Lookup::Exact {
                rhs: &Rhs::Keys(k(":w<CR>")),
                ambiguous: false
            }
        );
        assert_eq!(map.lookup(MapMode::Normal, &k(",z"), false), Lookup::None);
        assert_eq!(map.lookup(MapMode::Insert, &k(",;"), false), Lookup::None);
    }

    #[test]
    fn tree_only_gets_window_and_ex_mappings() {
        let map = Keymap::from_neovim_config();
        let k = parse_keys;
        assert!(matches!(
            map.lookup(MapMode::Normal, &k("<Tab>"), true),
            Lookup::Exact { .. }
        ));
        assert!(matches!(
            map.lookup(MapMode::Normal, &k("<C-l>"), true),
            Lookup::Exact { .. }
        ));
        assert_eq!(map.lookup(MapMode::Normal, &k("∆"), true), Lookup::None);
    }
}
