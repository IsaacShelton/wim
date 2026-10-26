//! The sidebar file tree, toggled with Ctrl+n.
//!
//! Keys while it has focus: `j`/`k` move, `gg`/`G` jump, `<CR>`/`o` open a
//! file or toggle a directory, `l` expands, `h` collapses (or goes to the
//! parent), `R` re-reads the disk, `q` hides the tree, `<Esc>` returns to the
//! editor.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::editor::keys::{Key, KeyInput};

/// Entries never shown in the tree.
const HIDDEN: &[&str] = &[".git", ".DS_Store"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    pub depth: usize,
    pub expanded: bool,
    /// A directory with nothing (visible) in it.
    pub empty: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TreeAction {
    None,
    Open(PathBuf),
    Close,
    FocusEditor,
}

pub struct FileTree {
    root: PathBuf,
    expanded: HashSet<PathBuf>,
    /// Directory listings, cached until [`FileTree::refresh`].
    listings: HashMap<PathBuf, Vec<(String, bool)>>,
    /// Paths git ignores, hidden like nvim-tree's `git_ignored` filter.
    ignored: HashSet<PathBuf>,
    rows: Vec<Row>,
    selected: usize,
    scroll: usize,
    view_rows: usize,
    pending_g: bool,
}

impl FileTree {
    pub fn new(root: PathBuf) -> Self {
        let mut tree = Self {
            ignored: git_ignored(&root),
            root,
            expanded: HashSet::new(),
            listings: HashMap::new(),
            rows: Vec::new(),
            selected: 0,
            scroll: 0,
            view_rows: 20,
            pending_g: false,
        };
        tree.rebuild();
        tree
    }

    pub fn set_root(&mut self, root: PathBuf) {
        if root != self.root {
            self.ignored = git_ignored(&root);
            self.root = root;
            self.expanded.clear();
            self.listings.clear();
            self.rows.clear();
            self.selected = 0;
            self.scroll = 0;
            self.rebuild();
        }
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    pub fn scroll(&self) -> usize {
        self.scroll
    }

    pub fn set_view_rows(&mut self, rows: usize) {
        self.view_rows = rows.max(1);
        self.keep_selection_visible();
    }

    /// Re-read directories from disk.
    pub fn refresh(&mut self) {
        self.listings.clear();
        self.ignored = git_ignored(&self.root);
        self.rebuild();
    }

    fn listing(&mut self, dir: &Path) -> Vec<(String, bool)> {
        if let Some(entries) = self.listings.get(dir) {
            return entries.clone();
        }
        let mut entries: Vec<(String, bool)> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(Result::ok)
                    .map(|e| {
                        (
                            e.file_name().to_string_lossy().into_owned(),
                            e.path().is_dir(),
                        )
                    })
                    .filter(|(name, _)| {
                        !HIDDEN.contains(&name.as_str()) && !self.ignored.contains(&dir.join(name))
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Directories first, then case-insensitive by name.
        entries.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
        });
        self.listings.insert(dir.to_path_buf(), entries.clone());
        entries
    }

    fn rebuild(&mut self) {
        let selected_path = self.rows.get(self.selected).map(|r| r.path.clone());
        let mut rows = Vec::new();
        let root = self.root.clone();
        self.push_children(&root, 0, &mut rows);
        self.rows = rows;
        if let Some(i) = selected_path.and_then(|p| self.rows.iter().position(|r| r.path == p)) {
            self.selected = i;
        }
        self.selected = self.selected.min(self.rows.len().saturating_sub(1));
        self.keep_selection_visible();
    }

    fn push_children(&mut self, dir: &Path, depth: usize, rows: &mut Vec<Row>) {
        for (name, is_dir) in self.listing(dir) {
            let path = dir.join(&name);
            let expanded = is_dir && self.expanded.contains(&path);
            let empty = is_dir && self.listing(&path).is_empty();
            rows.push(Row {
                path: path.clone(),
                name,
                is_dir,
                depth,
                expanded,
                empty,
            });
            if expanded {
                self.push_children(&path, depth + 1, rows);
            }
        }
    }

    /// Expand the directories leading to `path` and select it.
    pub fn reveal(&mut self, path: &Path) {
        let Ok(rel) = path.strip_prefix(&self.root) else {
            return;
        };
        let mut dir = self.root.clone();
        let components: Vec<_> = rel.components().collect();
        for c in &components[..components.len().saturating_sub(1)] {
            dir.push(c);
            self.expanded.insert(dir.clone());
        }
        self.rebuild();
        if let Some(i) = self.rows.iter().position(|r| r.path == path) {
            self.select(i);
        }
    }

    pub fn select(&mut self, i: usize) {
        self.selected = i.min(self.rows.len().saturating_sub(1));
        self.keep_selection_visible();
    }

    /// Open the selected file, or toggle the selected directory.
    pub fn activate(&mut self) -> TreeAction {
        let Some(row) = self.rows.get(self.selected).cloned() else {
            return TreeAction::None;
        };
        if !row.is_dir {
            return TreeAction::Open(row.path);
        }
        if !self.expanded.remove(&row.path) {
            self.expanded.insert(row.path);
        }
        self.rebuild();
        TreeAction::None
    }

    fn collapse_or_parent(&mut self) {
        let Some(row) = self.rows.get(self.selected).cloned() else {
            return;
        };
        if row.expanded {
            self.expanded.remove(&row.path);
            self.rebuild();
        } else if let Some(i) = row
            .path
            .parent()
            .and_then(|p| self.rows.iter().position(|r| r.path == p))
        {
            self.select(i);
        }
    }

    pub fn scroll_by(&mut self, delta: isize) {
        let max = self.rows.len().saturating_sub(self.view_rows);
        self.scroll = self.scroll.saturating_add_signed(delta).min(max);
    }

    fn keep_selection_visible(&mut self) {
        if self.selected < self.scroll {
            self.scroll = self.selected;
        }
        if self.selected >= self.scroll + self.view_rows {
            self.scroll = self.selected + 1 - self.view_rows;
        }
    }

    pub fn handle_key(&mut self, key: KeyInput) -> TreeAction {
        let after_g = std::mem::take(&mut self.pending_g);
        let half = (self.view_rows / 2).max(1);
        match (key.key, key.ctrl) {
            (Key::Char('j'), false) | (Key::Down, _) => self.select(self.selected + 1),
            (Key::Char('k'), false) | (Key::Up, _) => self.select(self.selected.saturating_sub(1)),
            (Key::Char('d'), true) | (Key::PageDown, _) => self.select(self.selected + half),
            (Key::Char('u'), true) | (Key::PageUp, _) => {
                self.select(self.selected.saturating_sub(half))
            }
            (Key::Char('g'), false) if after_g => self.select(0),
            (Key::Char('g'), false) => self.pending_g = true,
            (Key::Char('G'), false) => self.select(usize::MAX),
            (Key::Enter, _) | (Key::Char('o'), false) => return self.activate(),
            (Key::Char('l'), false) | (Key::Right, _) => {
                if self.rows.get(self.selected).is_some_and(|r| !r.expanded) {
                    return self.activate();
                }
            }
            (Key::Char('h'), false) | (Key::Left, _) => self.collapse_or_parent(),
            (Key::Char('R'), false) => self.refresh(),
            (Key::Char('q'), false) => return TreeAction::Close,
            (Key::Esc, _) => return TreeAction::FocusEditor,
            _ => {}
        }
        TreeAction::None
    }
}

/// Paths that git ignores under `root`; empty outside a repository.
fn git_ignored(root: &Path) -> HashSet<PathBuf> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ])
        .output();
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| root.join(l.trim_end_matches('/')))
            .collect(),
        _ => HashSet::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::keys::parse_keys;

    fn names(tree: &FileTree) -> Vec<String> {
        tree.rows()
            .iter()
            .map(|r| format!("{}{}", "  ".repeat(r.depth), r.name))
            .collect()
    }

    fn press(tree: &mut FileTree, keys: &str) -> TreeAction {
        let mut last = TreeAction::None;
        for k in parse_keys(keys) {
            last = tree.handle_key(k);
        }
        last
    }

    #[test]
    fn navigates_directories() {
        let root = std::env::temp_dir().join(format!("wim-tree-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        for f in ["b.txt", "A.md", "src/main.rs", "src/deep/x.rs"] {
            std::fs::write(root.join(f), "").unwrap();
        }
        let mut tree = FileTree::new(root.clone());
        assert_eq!(
            names(&tree),
            ["src", "A.md", "b.txt"],
            "dirs first, case-insensitive, .git hidden"
        );

        assert_eq!(press(&mut tree, "<CR>"), TreeAction::None);
        assert_eq!(
            names(&tree),
            ["src", "  deep", "  main.rs", "A.md", "b.txt"]
        );
        assert_eq!(
            press(&mut tree, "jj<CR>"),
            TreeAction::Open(root.join("src/main.rs"))
        );
        press(&mut tree, "hh");
        assert_eq!(
            names(&tree),
            ["src", "A.md", "b.txt"],
            "h goes to parent, then collapses it"
        );
        assert_eq!(
            press(&mut tree, "G<CR>"),
            TreeAction::Open(root.join("b.txt"))
        );

        tree.reveal(&root.join("src/deep/x.rs"));
        assert_eq!(
            tree.rows()[tree.selected()].path,
            root.join("src/deep/x.rs")
        );
        assert_eq!(press(&mut tree, "q"), TreeAction::Close);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn hides_git_ignored_files() {
        let root = std::env::temp_dir().join(format!("wim-tree-git-{}", std::process::id()));
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::write(root.join("main.rs"), "").unwrap();
        std::fs::write(root.join("debug.log"), "").unwrap();
        let init = std::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(&root)
            .status();
        if !init.is_ok_and(|s| s.success()) {
            return; // git isn't available; nothing to test.
        }
        let tree = FileTree::new(root.clone());
        assert_eq!(names(&tree), ["empty", ".gitignore", "main.rs"]);
        assert!(tree.rows()[0].empty);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
