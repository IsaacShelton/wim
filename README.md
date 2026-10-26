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
| `src/editor/ex.rs` | `:` commands |
| `src/editor/search.rs` | Translates Vim regex syntax to the `regex` crate |
| `src/highlight.rs` | Syntax highlighting for Rust, C/C++, JS/TS, Python, Go, Java-likes, shell, Lua, JSON and config files |
| `src/app.rs` | Window: translates input and paints text, gutter, cursor, status line and command line |

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
with counts (`3ix<Esc>`, `3.`, `5x`).

**Registers:** unnamed, `"a`–`"z` (uppercase appends), `"0`, `"1`–`"9`, `"-`, black hole `"_`,
and the system clipboard as `"+` / `"*`.

**Insert mode:** auto-indent, extra indent after `{ ( [`, a closing `}` dedents,
`<Tab>` inserts spaces, `<BS>` removes one indent level, `<C-w> <C-u> <C-t> <C-d>`.

**Scrolling:** `<C-d> <C-u> <C-f> <C-b> <C-e> <C-y>`, `zz zt zb`, mouse wheel.

**Search:** incremental, highlights matches, wraps around. Vim regex syntax: `\<word\>`,
`\(group\)`, `\|`, `\+`, `\{n,m}`, `\v`, `\c`.

**Ex commands:** `:w [file]`, `:q[!]`, `:wq`, `:x`, `ZZ`, `ZQ`, `:e[!] file` (Tab completes paths),
`:[range]s/pat/rep/[gie]` (`\1` and `&` in the replacement), `:d`, `:y`, `:m`, `:t`, `:>`, `:<`,
`:j`, `:sort[!] [iu]`, `:noh`, `:reg`, `:pwd`, `:cd`, `:{N}`, `:undo`, `:redo`.
Ranges: `%`, `.`, `$`, `N`, `'<,'>`, `'a`, `+N`/`-N` offsets.

**Options (`:set`):** `number`, `relativenumber`, `ignorecase`, `smartcase`, `hlsearch`,
`incsearch`, `expandtab`, `autoindent`, `tabstop`, `shiftwidth`, `scrolloff`,
`clipboard=unnamed`. Each supports the `no`, `!` and `?` forms.

**Desktop additions:** click to place the cursor, drag to select, Cmd+C / Cmd+X copy or cut the
selection, Cmd+V pastes, Cmd+S saves, Cmd+= / Cmd+- zoom. Closing the window with unsaved changes
shows a warning first; closing again discards the changes.

## Not supported yet

Multiple buffers, splits or tabs; macros (`q`); Visual Block mode; line wrapping; undo
of only part of an Insert session; a config file.
# wim
