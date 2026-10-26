# Wim

A Vim-like code editor in Rust that runs in a native desktop window
(eframe/egui). Not a terminal app: Wim draws its own window.

```sh
cargo run --release -- path/to/file.rs
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/editor/` | Editor core, independent of the GUI and unit tested |
| `src/editor/command.rs` | Parses Normal/Visual key sequences (`"a3d2w`, `ci(`, `gUiw`) into commands |
| `src/editor/motion.rs`, `textobj.rs`, `ops.rs` | Motions, text objects, operators |
| `src/editor/buffers.rs` | Multiple buffers and file I/O |
| `src/editor/ex.rs` | `:` commands |
| `src/editor/search.rs` | Translates Vim regex syntax to the `regex` crate |
| `src/highlight.rs` | Syntax highlighting for Rust, C/C++, JS/TS, Python, Go, Java-likes, shell, Lua, JSON and config files |
| `src/filetree.rs` | The sidebar file tree |
| `src/keymap.rs` | Key mappings translated from `~/.config/nvim/init.lua` |
| `src/icons.rs` | File icons, generated from nvim-web-devicons plus `~/.config/nvim/lua/dev_icons.lua` |
| `src/app.rs` | Window: translates input and paints the tree, buffer tabs, text, gutter, cursor, status line and command line |

Run the tests with `cargo test`.

## Supported Vim features

**Modes:** Normal, Insert, Replace (`R`), Visual (`v`), Visual Line (`V`), command line (`:`, `/`, `?`).

**Motions:** `h j k l`, `w W b B e E ge gE`, `0 ^ $ g_ |`, `gg G` (with counts),
`f F t T ; ,`, `%` and `N%`, `{ }`, `H M L`, `+ - _ <CR>`, `n N * #`, marks (`ma`, `'a`, `` `a ``, `''`).
Counts work everywhere (`3w`, `d2w`, `2d3w`).

**Operators:** `d c y > < gu gU g~`, combined with any motion or text object; doubled
forms for whole lines (`dd`, `cc`, `yy`, `>>`, `gUU`).

**Text objects:** `iw aw iW aW`, `i" a" i' a'`, ``i` a` ``, `i( a( ib`, `i{ a{ iB`, `i[ a[`, `i< a<`, `ip ap`.

**Editing:** `x X s S D C Y p P r J gJ ~ u <C-r> . <C-a> <C-x>`, `i a I A o O gI`,
with counts (`3ix<Esc>`, `3.`, `5x`). Yanked text flashes briefly.

**Registers:** unnamed, `"a`–`"z` (uppercase appends), `"0`, `"1`–`"9`, `"-`, black hole `"_`,
and the system clipboard as `"+` / `"*`.

**Insert mode:** auto-indent, extra indent after `{ ( [`, a closing `}` dedents,
`<Tab>` inserts spaces, `<BS>` removes one indent level, `<C-w> <C-u> <C-t> <C-d>`.
macOS word editing: Option+Left/Right move by word, Option+Delete (⌫) deletes the word before
the cursor, Option+fn+Delete (⌦) deletes the word after it. Option+Left/Right also move by
word in Normal mode, and Option+Delete deletes a word on the command line.

**Scrolling:** `<C-d> <C-u> <C-f> <C-b> <C-e> <C-y>`, `zz zt zb`, mouse wheel.

**Search:** incremental, highlights matches, wraps around. Vim regex syntax: `\<word\>`,
`\(group\)`, `\|`, `\+`, `\{n,m}`, `\v`, `\c`.

**Buffers:** `:e file` opens a file in a new buffer (or switches to it if already open), and
each buffer keeps its own cursor, undo history and marks. `:ls`, `:b N`, `:b name`, `:b#`,
`<C-^>` (alternate buffer), `:bn`, `:bp`, `:bfirst`, `:blast`, `:bd[!] [N]`, `:enew`, `:wa`,
`:wqa`/`:xa`. A tab line across the top shows the open buffers when there is more than one;
click a tab to switch. `:q` refuses while any buffer has unsaved changes.

**File tree:** Ctrl+n shows or hides a sidebar tree of the working directory and focuses it,
set up like the nvim-tree config: 30 columns wide, Nerd Font folder and file icons (from an
installed Nerd Font such as FiraMono Nerd Font), git-ignored files hidden, no root label. It
follows the current file. In the tree: `j`/`k` move, `gg`/`G` jump, `<CR>`/`o` opens a file or
toggles a folder, `l` expands, `h` collapses or goes to the parent, `R` re-reads the disk, `q`
hides it, `<Esc>` returns to the editor. Ctrl+h / Ctrl+l (or `<C-w>h`, `<C-w>l`, `<C-w>w`)
move focus between the tree and the editor. Clicking works too.

## Key mappings

These come from `~/.config/nvim/init.lua`. The leader is `,`, and a key that could start a
longer mapping waits 300 ms (`timeoutlen`) before being typed normally. As in Neovim,
Normal-mode mappings don't apply in the middle of a command, so `f,` still finds a comma.

| Keys | Mode | Action |
| --- | --- | --- |
| Ctrl+h / Ctrl+l | Normal | Focus the window to the left / right (file tree ⇄ editor) |
| Ctrl+h/j/k/l | Insert | Move the cursor left/down/up/right |
| Tab / Shift+Tab | Normal | Next / previous buffer |
| Ctrl+n | Normal | Toggle the file tree |
| `,;` `,o` `,'` | Normal | `:w` |
| `,:` | Normal | `:wqa` |
| `,v` / `,V` | Normal | `:q` / `:q!` |
| `,x` / `,X` / `,K` | Normal | Close this buffer / all buffers / all other buffers |
| `,p` / `,P` | Normal, Visual | Paste the last yank (`"0p` / `"0P`) |
| `,d` | Normal, Visual | `dd` |
| Option+j / Option+k (`∆` `˚`) | Normal, Visual | `}` / `{` |
| `[f` / `]f` | Normal, Visual | Jump to the outermost enclosing `{` / `}` |
| Option+Shift+j / k | Normal | Start Visual Line mode |
| Option+Shift+j / k | Visual | Move the selected lines down / up |
| Option+a/r/s/t (`å` `®` `ß` `†`) | Normal | Jump to global mark A/R/S/T and centre (`'Azz`) |
| Option+Shift+a/r/s/t | Normal | Set global mark A/R/S/T |
| Option+c / Option+d (`ç` `∂`) | Normal | Insert the next typed character before / after the cursor |
| Esc | Normal | Also clears search highlighting |

Mappings for plugins Wim doesn't have (Telescope, LSP, gitsigns, nvim-spider, the theme
toggle, Rust auto-import) are left out, as are `<C-y>` (jump list) and the `=` re-indent
step of the line-moving mappings.

**Ex commands:** `:w [file]`, `:q[!]`, `:wq`, `:x`, `ZZ`, `ZQ`, `:e[!] [file]` (Tab completes paths),
`:[range]s/pat/rep/[gie]` (`\1` and `&` in the replacement), `:d`, `:y`, `:m`, `:t`, `:>`, `:<`,
`:j`, `:sort[!] [iu]`, `:noh`, `:reg`, `:pwd`, `:cd`, `:{N}`, `:undo`, `:redo`.
Ranges: `%`, `.`, `$`, `N`, `'<,'>`, `'a`, `+N`/`-N` offsets. Buffers: `:%bd` closes all,
`:bonly` closes all but the current one.

**Marks:** `a`–`z` are per buffer; `A`–`Z` are global and jump to their file, reopening it if
it was closed.

**Motions also include** `[{` `]}` `[(` `])` (enclosing unmatched bracket).

**Options (`:set`):** `number`, `relativenumber` (both on by default: relative numbers, with
the absolute number on the cursor line), `ignorecase`, `smartcase`, `hlsearch`,
`incsearch`, `expandtab`, `autoindent`, `tabstop`, `shiftwidth`, `scrolloff`,
`clipboard=unnamed`. Each supports the `no`, `!` and `?` forms.

**Desktop additions:** click to place the cursor, drag to select, Cmd+C / Cmd+X copy or cut the
selection, Cmd+V pastes, Cmd+S saves, Cmd+= / Cmd+- zoom. Closing the window with unsaved changes
shows a warning first; closing again discards the changes.

## Not supported yet

Splits; macros (`q`); Visual Block mode; line wrapping; undo
of only part of an Insert session; a config file.
