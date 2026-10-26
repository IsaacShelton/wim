//! A small, line-oriented syntax highlighter. It understands comments,
//! strings, numbers, keywords and a few naming conventions for a handful of
//! common languages, carrying block-comment and string state across lines.

use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Token {
    Normal,
    Keyword,
    Type,
    Constant,
    String,
    Comment,
    Number,
    Function,
    Macro,
}

pub struct Language {
    pub name: &'static str,
    keywords: &'static [&'static str],
    types: &'static [&'static str],
    constants: &'static [&'static str],
    line_comments: &'static [&'static str],
    block_comment: Option<(&'static str, &'static str)>,
    quotes: &'static [char],
    triple_quotes: bool,
    /// Rust: `'a` is a lifetime unless it closes like a char literal.
    lifetimes: bool,
    /// Rust: `name!` is a macro invocation.
    bang_macros: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum State {
    #[default]
    Normal,
    BlockComment,
    Str(char),
    TripleStr(char),
}

const RUST: Language = Language {
    name: "rust",
    keywords: &[
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
        "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut",
        "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "type",
        "unsafe", "use", "where", "while", "yield",
    ],
    types: &[
        "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
        "f32", "f64", "bool", "char", "str",
    ],
    constants: &["true", "false", "None", "Some", "Ok", "Err"],
    line_comments: &["//"],
    block_comment: Some(("/*", "*/")),
    quotes: &['"', '\''],
    triple_quotes: false,
    lifetimes: true,
    bang_macros: true,
};

const C: Language = Language {
    name: "c",
    keywords: &[
        "auto",
        "break",
        "case",
        "class",
        "const",
        "constexpr",
        "continue",
        "default",
        "delete",
        "do",
        "else",
        "enum",
        "explicit",
        "extern",
        "for",
        "friend",
        "goto",
        "if",
        "inline",
        "namespace",
        "new",
        "operator",
        "private",
        "protected",
        "public",
        "register",
        "return",
        "sizeof",
        "static",
        "struct",
        "switch",
        "template",
        "this",
        "throw",
        "try",
        "catch",
        "typedef",
        "typename",
        "union",
        "using",
        "virtual",
        "volatile",
        "while",
        "#include",
        "#define",
        "#ifdef",
        "#ifndef",
        "#endif",
        "#if",
        "#else",
        "#pragma",
    ],
    types: &[
        "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "bool",
        "size_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t",
        "int64_t", "auto",
    ],
    constants: &["true", "false", "NULL", "nullptr"],
    line_comments: &["//"],
    block_comment: Some(("/*", "*/")),
    quotes: &['"', '\''],
    triple_quotes: false,
    lifetimes: false,
    bang_macros: false,
};

const JS: Language = Language {
    name: "javascript",
    keywords: &[
        "async",
        "await",
        "break",
        "case",
        "catch",
        "class",
        "const",
        "continue",
        "debugger",
        "default",
        "delete",
        "do",
        "else",
        "export",
        "extends",
        "finally",
        "for",
        "from",
        "function",
        "if",
        "import",
        "in",
        "instanceof",
        "let",
        "new",
        "of",
        "return",
        "static",
        "super",
        "switch",
        "this",
        "throw",
        "try",
        "typeof",
        "var",
        "void",
        "while",
        "with",
        "yield",
        "interface",
        "type",
        "enum",
        "implements",
        "private",
        "public",
        "protected",
        "readonly",
        "as",
    ],
    types: &[
        "string", "number", "boolean", "any", "unknown", "never", "object", "symbol", "bigint",
    ],
    constants: &["true", "false", "null", "undefined", "NaN", "Infinity"],
    line_comments: &["//"],
    block_comment: Some(("/*", "*/")),
    quotes: &['"', '\'', '`'],
    triple_quotes: false,
    lifetimes: false,
    bang_macros: false,
};

const PYTHON: Language = Language {
    name: "python",
    keywords: &[
        "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
        "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
        "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with",
        "yield", "match", "case", "self",
    ],
    types: &[
        "int", "float", "str", "bool", "list", "dict", "set", "tuple", "bytes", "object",
    ],
    constants: &["True", "False", "None"],
    line_comments: &["#"],
    block_comment: None,
    quotes: &['"', '\''],
    triple_quotes: true,
    lifetimes: false,
    bang_macros: false,
};

const GO: Language = Language {
    name: "go",
    keywords: &[
        "break",
        "case",
        "chan",
        "const",
        "continue",
        "default",
        "defer",
        "else",
        "fallthrough",
        "for",
        "func",
        "go",
        "goto",
        "if",
        "import",
        "interface",
        "map",
        "package",
        "range",
        "return",
        "select",
        "struct",
        "switch",
        "type",
        "var",
    ],
    types: &[
        "bool",
        "byte",
        "complex64",
        "complex128",
        "error",
        "float32",
        "float64",
        "int",
        "int8",
        "int16",
        "int32",
        "int64",
        "rune",
        "string",
        "uint",
        "uint8",
        "uint16",
        "uint32",
        "uint64",
        "uintptr",
        "any",
    ],
    constants: &["true", "false", "nil", "iota"],
    line_comments: &["//"],
    block_comment: Some(("/*", "*/")),
    quotes: &['"', '\'', '`'],
    triple_quotes: false,
    lifetimes: false,
    bang_macros: false,
};

const JAVA: Language = Language {
    name: "java",
    keywords: &[
        "abstract",
        "assert",
        "break",
        "case",
        "catch",
        "class",
        "continue",
        "default",
        "do",
        "else",
        "enum",
        "extends",
        "final",
        "finally",
        "for",
        "if",
        "implements",
        "import",
        "instanceof",
        "interface",
        "native",
        "new",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "static",
        "super",
        "switch",
        "synchronized",
        "this",
        "throw",
        "throws",
        "try",
        "var",
        "volatile",
        "while",
        "fun",
        "val",
        "when",
        "object",
        "override",
    ],
    types: &[
        "boolean", "byte", "char", "double", "float", "int", "long", "short", "void",
    ],
    constants: &["true", "false", "null"],
    line_comments: &["//"],
    block_comment: Some(("/*", "*/")),
    quotes: &['"', '\''],
    triple_quotes: false,
    lifetimes: false,
    bang_macros: false,
};

const SHELL: Language = Language {
    name: "sh",
    keywords: &[
        "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
        "in", "function", "return", "local", "export", "echo", "exit", "source", "set", "unset",
    ],
    types: &[],
    constants: &["true", "false"],
    line_comments: &["#"],
    block_comment: None,
    quotes: &['"', '\''],
    triple_quotes: false,
    lifetimes: false,
    bang_macros: false,
};

const CONFIG: Language = Language {
    name: "conf",
    keywords: &[],
    types: &[],
    constants: &["true", "false", "null", "yes", "no", "on", "off"],
    line_comments: &["#"],
    block_comment: None,
    quotes: &['"', '\''],
    triple_quotes: false,
    lifetimes: false,
    bang_macros: false,
};

const JSON: Language = Language {
    name: "json",
    keywords: &[],
    types: &[],
    constants: &["true", "false", "null"],
    line_comments: &[],
    block_comment: None,
    quotes: &['"'],
    triple_quotes: false,
    lifetimes: false,
    bang_macros: false,
};

const LUA: Language = Language {
    name: "lua",
    keywords: &[
        "and", "break", "do", "else", "elseif", "end", "for", "function", "goto", "if", "in",
        "local", "not", "or", "repeat", "return", "then", "until", "while",
    ],
    types: &[],
    constants: &["true", "false", "nil"],
    line_comments: &["--"],
    block_comment: Some(("--[[", "]]")),
    quotes: &['"', '\''],
    triple_quotes: false,
    lifetimes: false,
    bang_macros: false,
};

pub fn detect(path: Option<&Path>) -> Option<&'static Language> {
    let path = path?;
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    if matches!(
        name.as_str(),
        "makefile" | "dockerfile" | ".bashrc" | ".zshrc" | ".profile"
    ) {
        return Some(&SHELL);
    }
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    Some(match ext.as_str() {
        "rs" => &RUST,
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "m" | "mm" => &C,
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" => &JS,
        "py" | "pyi" => &PYTHON,
        "go" => &GO,
        "java" | "kt" | "kts" | "scala" | "cs" | "swift" | "dart" => &JAVA,
        "sh" | "bash" | "zsh" | "fish" => &SHELL,
        "toml" | "yaml" | "yml" | "ini" | "cfg" | "conf" => &CONFIG,
        "json" => &JSON,
        "lua" => &LUA,
        _ => return None,
    })
}

fn starts_with(line: &[char], at: usize, pat: &str) -> bool {
    let mut i = at;
    for c in pat.chars() {
        if line.get(i) != Some(&c) {
            return false;
        }
        i += 1;
    }
    true
}

fn find(line: &[char], from: usize, pat: &str) -> Option<usize> {
    (from..line.len()).find(|&i| starts_with(line, i, pat))
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Highlight one line given the state at its start. Returns the spans
/// `(start, end, token)` in char columns and the state at the line's end.
pub fn highlight_line(
    lang: &Language,
    line: &[char],
    mut state: State,
) -> (Vec<(usize, usize, Token)>, State) {
    let n = line.len();
    let mut spans = Vec::new();
    let mut i = 0;
    let mut seg = 0;
    while i < n {
        match state {
            State::BlockComment => {
                let end = lang.block_comment.map_or("*/", |b| b.1);
                match find(line, i, end) {
                    Some(j) => {
                        let e = j + end.chars().count();
                        spans.push((seg, e, Token::Comment));
                        i = e;
                        state = State::Normal;
                    }
                    None => {
                        spans.push((seg, n, Token::Comment));
                        i = n;
                    }
                }
            }
            State::Str(q) => {
                let mut j = i;
                let mut closed = None;
                while j < n {
                    if line[j] == '\\' {
                        j += 2;
                        continue;
                    }
                    if line[j] == q {
                        closed = Some(j + 1);
                        break;
                    }
                    j += 1;
                }
                let end = closed.unwrap_or(n);
                spans.push((seg, end, Token::String));
                i = end;
                if closed.is_some() || q == '\'' {
                    state = State::Normal;
                }
            }
            State::TripleStr(q) => {
                let pat: String = [q; 3].iter().collect();
                match find(line, i, &pat) {
                    Some(j) => {
                        spans.push((seg, j + 3, Token::String));
                        i = j + 3;
                        state = State::Normal;
                    }
                    None => {
                        spans.push((seg, n, Token::String));
                        i = n;
                    }
                }
            }
            State::Normal => {
                let c = line[i];
                seg = i;
                if lang.line_comments.iter().any(|p| starts_with(line, i, p)) {
                    if let Some((start, _)) =
                        lang.block_comment.filter(|(s, _)| starts_with(line, i, s))
                    {
                        i += start.chars().count();
                        state = State::BlockComment;
                        continue;
                    }
                    spans.push((i, n, Token::Comment));
                    break;
                }
                if let Some((start, _)) =
                    lang.block_comment.filter(|(s, _)| starts_with(line, i, s))
                {
                    i += start.chars().count();
                    state = State::BlockComment;
                    continue;
                }
                if lang.quotes.contains(&c) {
                    if lang.triple_quotes
                        && starts_with(line, i, &[c; 3].iter().collect::<String>())
                    {
                        i += 3;
                        state = State::TripleStr(c);
                        continue;
                    }
                    if c == '\'' && lang.lifetimes {
                        let is_char =
                            line.get(i + 1) == Some(&'\\') || line.get(i + 2) == Some(&'\'');
                        if !is_char {
                            let mut j = i + 1;
                            while j < n && is_ident(line[j]) {
                                j += 1;
                            }
                            spans.push((i, j.max(i + 1), Token::Macro));
                            i = j.max(i + 1);
                            continue;
                        }
                    }
                    i += 1;
                    state = State::Str(c);
                    continue;
                }
                if c.is_ascii_digit() && (i == 0 || !is_ident(line[i - 1])) {
                    let mut j = i + 1;
                    while j < n
                        && (is_ident(line[j])
                            || (line[j] == '.'
                                && line.get(j + 1).is_some_and(|c| c.is_ascii_digit())))
                    {
                        j += 1;
                    }
                    spans.push((i, j, Token::Number));
                    i = j;
                    continue;
                }
                if is_ident(c) || (c == '#' && lang.name == "c") || (c == '@' && lang.name != "c") {
                    let mut j = i + 1;
                    while j < n && is_ident(line[j]) {
                        j += 1;
                    }
                    let word: String = line[i..j].iter().collect();
                    let next = line[j..].iter().find(|c| !c.is_whitespace()).copied();
                    let token = if lang.keywords.contains(&word.as_str()) {
                        Token::Keyword
                    } else if lang.constants.contains(&word.as_str()) {
                        Token::Constant
                    } else if c == '@' || (lang.bang_macros && line.get(j) == Some(&'!')) {
                        Token::Macro
                    } else if lang.types.contains(&word.as_str()) || c.is_uppercase() {
                        if word.len() > 1
                            && word
                                .chars()
                                .all(|c| c.is_uppercase() || c.is_ascii_digit() || c == '_')
                        {
                            Token::Constant
                        } else {
                            Token::Type
                        }
                    } else if next == Some('(') {
                        Token::Function
                    } else {
                        Token::Normal
                    };
                    let end = if token == Token::Macro && line.get(j) == Some(&'!') {
                        j + 1
                    } else {
                        j
                    };
                    spans.push((i, end, token));
                    i = end;
                    continue;
                }
                i += 1;
            }
        }
    }
    (spans, state)
}

/// Caches the highlighter state at the start of each line, recomputed when
/// the buffer content changes.
#[derive(Default)]
pub struct Cache {
    version: Option<u64>,
    lang: Option<&'static str>,
    states: Vec<State>,
}

impl Cache {
    /// The state at the start of `line`, computing states as far as needed.
    pub fn state_at<'b>(
        &mut self,
        lang: &Language,
        version: u64,
        line: usize,
        lines: impl Fn(usize) -> &'b [char],
    ) -> State {
        if self.version != Some(version) || self.lang != Some(lang.name) {
            self.version = Some(version);
            self.lang = Some(lang.name);
            self.states.clear();
            self.states.push(State::Normal);
        }
        while self.states.len() <= line {
            let i = self.states.len() - 1;
            let (_, end) = highlight_line(lang, lines(i), self.states[i]);
            self.states.push(end);
        }
        self.states[line]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(lang: &Language, s: &str) -> Vec<(String, Token)> {
        let chars: Vec<char> = s.chars().collect();
        highlight_line(lang, &chars, State::Normal)
            .0
            .into_iter()
            .map(|(a, b, t)| (chars[a..b].iter().collect(), t))
            .collect()
    }

    #[test]
    fn rust_tokens() {
        let t = tokens(
            &RUST,
            "fn main() { let x: u32 = 42; println!(\"hi\"); } // done",
        );
        assert!(t.contains(&("fn".into(), Token::Keyword)));
        assert!(t.contains(&("main".into(), Token::Function)));
        assert!(t.contains(&("u32".into(), Token::Type)));
        assert!(t.contains(&("42".into(), Token::Number)));
        assert!(t.contains(&("println!".into(), Token::Macro)));
        assert!(t.contains(&("\"hi\"".into(), Token::String)));
        assert!(t.contains(&("// done".into(), Token::Comment)));
    }

    #[test]
    fn rust_lifetimes_and_chars() {
        let t = tokens(&RUST, "fn f<'a>(c: char) { 'x' }");
        assert!(t.contains(&("'a".into(), Token::Macro)));
        assert!(t.contains(&("'x'".into(), Token::String)));
    }

    #[test]
    fn block_comment_spans_lines() {
        let a: Vec<char> = "x /* start".chars().collect();
        let (_, state) = highlight_line(&C, &a, State::Normal);
        assert_eq!(state, State::BlockComment);
        let b: Vec<char> = "end */ y".chars().collect();
        let (spans, state) = highlight_line(&C, &b, state);
        assert_eq!(spans[0], (0, 6, Token::Comment));
        assert_eq!(state, State::Normal);
    }
}
