use super::keys::parse_keys;
use super::*;

/// Build an editor from text where `|` marks the cursor.
fn editor(text: &str) -> Editor {
    let idx = text.find('|').expect("cursor marker");
    let before = &text[..idx];
    let line = before.matches('\n').count();
    let col = before.rsplit('\n').next().unwrap().chars().count();
    let mut ed = Editor::from_text(&text.replacen('|', "", 1));
    ed.cursor = Pos::new(line, col);
    ed.update_want_col();
    ed
}

fn state(ed: &Editor) -> String {
    let mut lines: Vec<String> = (0..ed.buffer.line_count())
        .map(|l| ed.buffer.line_string(l))
        .collect();
    let c = ed.cursor;
    let byte = lines[c.line]
        .char_indices()
        .nth(c.col)
        .map_or(lines[c.line].len(), |(b, _)| b);
    lines[c.line].insert(byte, '|');
    lines.join("\n")
}

#[track_caller]
fn check(before: &str, keys: &str, after: &str) {
    let mut ed = editor(before);
    ed.handle_keys(&parse_keys(keys));
    assert_eq!(state(&ed), after, "keys: {keys}");
}

#[test]
fn basic_motions() {
    check("|foo bar baz", "w", "foo |bar baz");
    check("|foo bar baz", "2w", "foo bar |baz");
    check("foo bar |baz", "b", "foo |bar baz");
    check("|foo bar", "e", "fo|o bar");
    check("foo |bar", "ge", "fo|o bar");
    check("|foo.bar baz", "W", "foo.bar |baz");
    check("|foo\n\nbar", "w", "foo\n|\nbar");
    check("  |foo", "0", "|  foo");
    check("|  foo", "^", "  |foo");
    check("|foo", "$", "fo|o");
    check("a\nb\n|c", "gg", "|a\nb\nc");
    check("|a\nb\nc", "G", "a\nb\n|c");
    check("|a\nb\nc", "2G", "a\n|b\nc");
    check("|a\nb\nc", ":3<CR>", "a\nb\n|c");
}

#[test]
fn vertical_motion_keeps_column() {
    check("abc|def\nx\nabcdef", "jj", "abcdef\nx\nabc|def");
    check("ab|c\nabcdef", "$j", "abc\nabcde|f");
}

#[test]
fn find_and_repeat() {
    check("|a,b,c,d", "f,;", "a,b|,c,d");
    check("|a,b,c,d", "f,;,", "a|,b,c,d");
    check("|a,b,c,d", "t,;", "a,|b,c,d");
    check("a,b,c,|d", "F,", "a,b,c|,d");
    check("|a,b,c,d", "dt,", "|,b,c,d");
    check("|a,b,c,d", "df,", "|b,c,d");
}

#[test]
fn match_pair_and_paragraphs() {
    check("|(a [b])", "%", "(a [b]|)");
    check("(a [b]|)", "%", "|(a [b])");
    check("|a\nb\n\nc", "}", "a\nb\n|\nc");
    check("|a\nb\n\nc", "d}", "|\nc");
}

#[test]
fn delete_and_change() {
    check("|foo bar baz", "dw", "|bar baz");
    check("foo |bar\nbaz", "dw", "foo| \nbaz");
    check("|foo bar", "cwxyz<Esc>", "xy|z bar");
    check("fo|o bar", "cwX<Esc>", "fo|X bar");
    check("|abc", "3x", "|");
    check("ab|c", "x", "a|b");
    check("|abc", "D", "|");
    check("a|bc", "C!<Esc>", "a|!");
    check("|a\nb\nc", "dj", "|c");
    check("|a\nb\nc", "2dd", "|c");
    check("a\n|b", "dd", "|a");
    check("|one two three", "d2w", "|three");
    check("    |foo\nbar", "ccx<Esc>", "    |x\nbar");
    check("|foo", "sX<Esc>", "|Xoo");
    check("|abc", "3rx", "xx|x");
}

#[test]
fn text_objects() {
    check("foo b|ar baz", "diw", "foo | baz");
    check("foo b|ar baz", "daw", "foo |baz");
    check("say \"hel|lo\" now", "di\"", "say \"|\" now");
    check("say \"hel|lo\" now", "da\"", "say |now");
    check("f(|a, b)", "ci(x<Esc>", "f(|x)");
    check("f(a, (b|), c)", "d2i(", "f(|)");
    check("f(a, (b|), c)", "da(", "f(a, |, c)");
    check("fn x() {\n    |a;\n}", "ci{z<Esc>", "fn x() {\n    |z\n}");
    check("fn x() {\n    |a;\n}", "di{", "fn x() {\n|}");
    check("|a\nb\n\nc", "dap", "|c");
    check("|a\nb\n\nc", "yipP", "|a\nb\na\nb\n\nc");
}

#[test]
fn yank_and_put() {
    check("|a\nb\nc", "ddp", "b\n|a\nc");
    check("|a\nb", "yyP", "|a\na\nb");
    check("|foo bar", "yiwP", "fo|ofoo bar");
    check("|foo bar", "yiw$p", "foo barfo|o");
    check("|a\nb", "\"ayyj\"ap", "a\nb\n|a");
    check("|a\nb", "\"ayyj\"Ayy\"ap", "a\nb\n|a\nb");
    check("|foo bar", "yiwwviwp", "foo fo|o");
    check("|a\nb", "yy3p", "a\n|a\na\na\nb");
}

#[test]
fn insert_mode() {
    check("|", "ihello<Esc>", "hell|o");
    check("|a\nb", "Ax<Esc>", "a|x\nb");
    check("  |a", "Ix<Esc>", "  |xa");
    check("|", "3ia<Esc>", "aa|a");
    check("    |foo", "obar<Esc>", "    foo\n    ba|r");
    check("|foo", "Obar<Esc>", "ba|r\nfoo");
    check("|a", "3ox<Esc>", "a\nx\nx\n|x");
    check("|fn x() {", "A<CR>a<Esc>", "fn x() {\n    |a");
    check("|fn x() {}", "f}i<CR>a<Esc>", "fn x() {\n    |a\n}");
    check("    |", "A<CR><Esc>", "    \n|");
    check("|ab", "A<BS><BS>c<Esc>", "|c");
    check("a\n|b", "i<BS><Esc>", "|ab");
    check("|foo bar", "A<C-w>x<Esc>", "foo |x");
    check("|", "i<Tab>x<Esc>", "    |x");
    check("    |", "A}<Esc>", "|}");
    check("|abc", "Rxy<Esc>", "x|yc");
}

#[test]
fn undo_redo() {
    check("|abc", "xu", "|abc");
    check("|abc", "xu<C-r>", "|bc");
    check("|abc", "ifoo<Esc>u", "|abc");
    check("|abc", "xxuu", "|abc");
    check("|abc", "uu", "|abc");
}

#[test]
fn modified_tracks_undo() {
    let mut ed = editor("|abc");
    assert!(!ed.is_modified());
    ed.handle_keys(&parse_keys("x"));
    assert!(ed.is_modified());
    ed.handle_keys(&parse_keys("u"));
    assert!(!ed.is_modified());
}

#[test]
fn dot_repeat() {
    check("|one two three", "dw.", "|three");
    check("|a\nb", "Ax<Esc>j.", "ax\nb|x");
    check("|a b c d e", "dw3.", "|e");
    check("|foo foo", "cwbar<Esc>w.", "bar ba|r");
    check("|a\nb\nc", "dd.", "|c");
}

#[test]
fn visual_mode() {
    check("|hello world", "veU", "|HELLO world");
    check("|hello world", "vwd", "|orld");
    check("|a\nb", "Vj>", "    |a\n    b");
    check("|a\nb\nc", "Vjd", "|c");
    check("|abc", "vlyP", "a|babc");
    check("|a b c", "v$rx", "|xxxxx");
    check("|a\nb\nc", "VjJ", "a| b\nc");
    check("|abc", "vlo", "|abc");
    check("foo (b|ar) baz", "vi(d", "foo (|) baz");
}

#[test]
fn join_lines() {
    check("|a\n   b", "J", "a| b");
    check("|a\nb\nc", "3J", "a b| c");
    check("|a\n  b", "gJ", "a|  b");
}

#[test]
fn search() {
    check("foo\n|bar\nfoo", "/foo<CR>", "foo\nbar\n|foo");
    check("foo\n|bar\nfoo", "/foo<CR>n", "|foo\nbar\nfoo");
    check("foo\n|bar\nfoo", "?foo<CR>", "|foo\nbar\nfoo");
    check("foo\n|bar\nfoo", "/foo<CR>N", "|foo\nbar\nfoo");
    check("|foo bar foo", "*", "foo bar |foo");
    check("|foo foobar foo", "*", "foo foobar |foo");
    check("|a\nfoo1\nfoo2", "/foo\\d<CR>n", "a\nfoo1\n|foo2");
    check("|abc", "/zzz<CR>", "|abc");
    check("|a b", "/b<Esc>", "|a b");
}

#[test]
fn ex_commands() {
    check("|a a\na", ":%s/a/b/g<CR>", "b b\n|b");
    check("|a a\na", ":s/a/b/<CR>", "|b a\na");
    check(
        "|foo bar",
        ":s/\\(foo\\) \\(bar\\)/\\2 \\1/<CR>",
        "|bar foo",
    );
    check("|a\nb\nc", ":2,3d<CR>", "|a");
    check("|c\na\nb", ":sort<CR>", "|a\nb\nc");
    check("|a\nb\nc", ":1m$<CR>", "b\nc\n|a");
    check("|a\nb", ":t.<CR>", "a\n|a\nb");
    check("|a\nb\nc", "Vj:s/$/!/<CR>", "a!\n|b!\nc");
}

#[test]
fn ex_set_options() {
    let mut ed = editor("|x");
    ed.handle_keys(&parse_keys(":set nonu ts=8 ic<CR>"));
    assert!(!ed.options.number);
    assert_eq!(ed.options.tabstop, 8);
    assert!(ed.options.ignorecase);
    ed.handle_keys(&parse_keys(":set nu!<CR>"));
    assert!(ed.options.number);
    ed.handle_keys(&parse_keys(":set bogus<CR>"));
    assert!(ed.message().unwrap().error);
}

#[test]
fn quit_guards_unsaved_changes() {
    let mut ed = editor("|x");
    ed.handle_keys(&parse_keys("dd:q<CR>"));
    assert!(!ed.quit_requested());
    ed.handle_keys(&parse_keys(":q!<CR>"));
    assert!(ed.quit_requested());
}

#[test]
fn counts_case_and_increment() {
    check("|abc", "2~", "AB|c");
    check("|abc def", "gUiw", "|ABC def");
    check("|ABC", "guu", "|abc");
    check("x = |9", "<C-a>", "x = 1|0");
    check("x = |5", "3<C-x>", "x = |2");
    check("|x = -1", "<C-a>", "x = |0");
}

#[test]
fn marks() {
    check("|a\nb\nc", "majj'a", "|a\nb\nc");
    check("a|bc\nb", "majd'a", "|");
    check("|a\nb\nc", "Gx''", "|a\nb\n");
}

#[test]
fn write_and_reload_file() {
    let dir = std::env::temp_dir().join(format!("wim-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.txt");
    let mut ed = Editor::new();
    ed.open_file(&path);
    ed.handle_keys(&parse_keys("ihello<Esc>"));
    assert!(ed.is_modified());
    ed.handle_keys(&parse_keys(":w<CR>"));
    assert!(!ed.is_modified());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\n");
    let mut ed2 = Editor::new();
    ed2.open_file(&path);
    assert_eq!(ed2.buffer.text(), "hello");
    std::fs::remove_dir_all(&dir).unwrap();
}
