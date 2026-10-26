//! Ex (`:`) commands.

use std::path::PathBuf;

use super::buffer::Pos;
use super::ops::Range;
use super::registers::RegisterOp;
use super::{Editor, LastSearch, expand_tilde, search};

impl Editor {
    pub(crate) fn run_ex(&mut self, input: &str) {
        if self.undo_pending.is_none() {
            self.undo_pending = Some(self.snapshot());
        }
        if let Err(e) = self.ex_command(input) {
            self.set_error(e);
        }
        self.commit_undo();
        self.clamp_cursor();
    }

    fn ex_command(&mut self, input: &str) -> Result<(), String> {
        let input = input.trim_start_matches([':', ' ']);
        if input.is_empty() {
            return Ok(());
        }
        let whole_file = input.starts_with('%');
        let (range, rest) = self.parse_range(input)?;
        let rest = rest.trim_start();
        let name_len = rest
            .find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(rest.len());
        let name_len = if name_len == 0 && !rest.is_empty() {
            rest.chars().next().unwrap().len_utf8()
        } else {
            name_len
        };
        let (name, mut args) = rest.split_at(name_len);
        let bang = args.starts_with('!');
        if bang {
            args = &args[1..];
        }
        let args = args.trim();
        let current = self.cursor.line;
        let (first, last) = range.unwrap_or((current, current));

        match name {
            "" => {
                if range.is_some() {
                    self.marks.insert('\'', self.cursor);
                    self.cursor = Pos::new(last, self.buffer.first_non_blank(last));
                }
            }
            "w" | "write" => {
                self.write_file(path_arg(args));
            }
            "wa" | "wall" => {
                if self.write_all() {
                    self.set_message("All buffers written");
                }
            }
            "wq" | "x" | "xit" | "exit" => {
                let needs_write = name == "wq" || self.is_modified() || !args.is_empty();
                if !needs_write || self.write_file(path_arg(args)) {
                    self.request_quit(bang);
                }
            }
            "wqa" | "wqall" | "xa" | "xall" => {
                if self.write_all() {
                    self.request_quit(bang);
                }
            }
            "q" | "quit" | "qa" | "qall" | "quitall" | "clo" | "close" => {
                self.request_quit(bang);
            }
            "e" | "edit" => match path_arg(args) {
                // Other files open in their own buffer; this one keeps its changes.
                Some(path) => self.open_file(&path),
                None => {
                    if self.is_modified() && !bang {
                        return Err("E37: No write since last change (add ! to override)".into());
                    }
                    let path = self.file_path.clone().ok_or("E32: No file name")?;
                    self.load_file(&path);
                }
            },
            "ene" | "enew" => self.new_buffer(),
            "ls" | "buffers" | "files" => {
                let list: Vec<String> = self
                    .buffer_list()
                    .iter()
                    .map(|b| {
                        let active = if b.active { "%" } else { " " };
                        let modified = if b.modified { " +" } else { "" };
                        format!("{}{active} \"{}\"{modified}", b.id, b.name)
                    })
                    .collect();
                self.set_message(list.join("   "));
            }
            "b" | "bu" | "buf" | "buffer" => match args {
                "" => {}
                "#" => self.alternate_buffer(),
                _ => match args.parse::<usize>() {
                    Ok(id) => {
                        self.switch_to_buffer(id);
                    }
                    Err(_) => self.switch_by_name(args)?,
                },
            },
            "bn" | "bne" | "bnex" | "bnext" => self.cycle_buffer(1),
            "bp" | "bpr" | "bpre" | "bprev" | "bprevi" | "bprevio" | "bpreviou" | "bprevious" | "bN"
            | "bNext" => self.cycle_buffer(-1),
            "bf" | "bfirst" | "br" | "brewind" => self.first_or_last_buffer(false),
            "bl" | "blast" => self.first_or_last_buffer(true),
            "bd" | "bdelete" | "bw" | "bwipeout" | "bun" | "bunload" if whole_file => {
                self.delete_all_buffers(bang, false)?;
            }
            "bo" | "bonly" => self.delete_all_buffers(bang, true)?,
            "bd" | "bdelete" | "bw" | "bwipeout" | "bun" | "bunload" => {
                let id = if args.is_empty() {
                    None
                } else {
                    Some(args.parse::<usize>().map_err(|_| format!("E94: No matching buffer for {args}"))?)
                };
                self.delete_buffer(id, bang)?;
            }
            "s" | "substitute" => self.substitute(first, last, args)?,
            "d" | "delete" => {
                let reg = args.chars().next().filter(|c| c.is_ascii_alphabetic());
                self.apply_operator(super::command::Operator::Delete, Range::lines(first, last), reg);
            }
            "y" | "yank" => {
                let reg = args.chars().next().filter(|c| c.is_ascii_alphabetic());
                let text = (first..=last).map(|l| self.buffer.line_string(l)).collect::<Vec<_>>().join("\n");
                self.registers.set(reg, super::registers::Register { text, linewise: true }, RegisterOp::Yank);
            }
            ">" | "<" => {
                let times = 1 + args.chars().filter(|&c| c.to_string() == name).count();
                for _ in 0..times {
                    self.shift_lines(first, last, name == ">");
                }
                self.cursor = Pos::new(first, self.buffer.first_non_blank(first));
            }
            "j" | "join" => {
                let joins = if range.is_some() && last > first { last - first } else { 1 };
                self.join_lines(first, joins, !bang);
            }
            "m" | "move" => {
                // Lines go below `dest`; address 0 (`dest == -1`) means the top.
                let dest = self.parse_target(args)?;
                if (first as i64) <= dest && dest < last as i64 {
                    return Err("E134: Cannot move a range of lines into itself".into());
                }
                let lines = self.buffer.remove_lines(first, last);
                let n = lines.len();
                let at = if dest >= last as i64 { dest as usize + 1 - n } else { (dest + 1) as usize };
                self.buffer.insert_lines(at, lines);
                self.cursor = Pos::new(at + n - 1, self.buffer.first_non_blank(at + n - 1));
                self.shift_visual_marks(first, last, at as i64 - first as i64);
            }
            "t" | "co" | "copy" => {
                let dest = self.parse_target(args)?;
                let lines: Vec<Vec<char>> = (first..=last).map(|l| self.buffer.line(l).to_vec()).collect();
                let at = (dest + 1) as usize;
                let n = lines.len();
                self.buffer.insert_lines(at, lines);
                self.cursor = Pos::new(at + n - 1, self.buffer.first_non_blank(at + n - 1));
            }
            "sor" | "sort" => {
                let (first, last) = range.unwrap_or((0, self.buffer.last_line()));
                let mut lines: Vec<String> = (first..=last).map(|l| self.buffer.line_string(l)).collect();
                if args.contains('i') {
                    lines.sort_by_key(|l| l.to_lowercase());
                } else {
                    lines.sort();
                }
                if bang {
                    lines.reverse();
                }
                if args.contains('u') {
                    lines.dedup();
                }
                self.buffer.insert_lines(last + 1, lines.iter().map(|l| l.chars().collect()).collect());
                self.buffer.remove_lines(first, last);
            }
            "noh" | "nohlsearch" => self.hlsearch_active = false,
            "se" | "set" => self.set_options(args)?,
            "u" | "undo" => self.undo(),
            "red" | "redo" => self.redo(),
            "reg" | "registers" | "di" | "display" => {
                let names = "\"0123456789abcdefghijklmnopqrstuvwxyz-+";
                let mut parts = Vec::new();
                for c in names.chars() {
                    if c == '+' {
                        continue;
                    }
                    if let Some(r) = self.registers.get(Some(c)) {
                        let preview: String = r.text.chars().take(40).collect::<String>().replace('\n', "^J");
                        parts.push(format!("\"{c} {preview}"));
                    }
                }
                self.set_message(if parts.is_empty() { "No registers set".to_string() } else { parts.join("  |  ") });
            }
            "pw" | "pwd" => {
                let dir = std::env::current_dir().map_err(|e| e.to_string())?;
                self.set_message(dir.display().to_string());
            }
            "cd" => {
                let dir = expand_tilde(if args.is_empty() { "~" } else { args });
                std::env::set_current_dir(&dir).map_err(|e| format!("E344: Can't find directory \"{dir}\": {e}"))?;
                self.set_message(dir);
            }
            "h" | "help" => self.set_message(
                "Wim: :w :q[!] :wq :e file :ls :b N :bn :bp :bd :[range]s/pat/rep/[gi] :set opt :noh :sort :reg  Ctrl+n: file tree",
            ),
            _ => return Err(format!("E492: Not an editor command: {input}")),
        }
        Ok(())
    }

    /// Parse an optional line range at the start of `s`.
    fn parse_range<'a>(&self, s: &'a str) -> Result<(Option<(usize, usize)>, &'a str), String> {
        if let Some(rest) = s.strip_prefix('%') {
            return Ok((Some((0, self.buffer.last_line())), rest));
        }
        let Some((first, rest)) = self.parse_address(s)? else {
            return Ok((None, s));
        };
        let (last, rest) = match rest.strip_prefix([',', ';']) {
            Some(r) => self.parse_address(r)?.ok_or("E14: Invalid address")?,
            None => (first, rest),
        };
        let (first, last) = if first <= last {
            (first, last)
        } else {
            (last, first)
        };
        Ok((Some((first, last)), rest))
    }

    /// Parse a single address (`12`, `.`, `$`, `'a`, with `+N`/`-N` offsets).
    /// The destination address of `:m` and `:t`, where `-1` is address 0
    /// (above the first line).
    fn parse_target(&self, args: &str) -> Result<i64, String> {
        Ok(self
            .parse_address_raw(args)?
            .ok_or("E14: Invalid address")?
            .0)
    }

    /// Move the visual marks (and `gv`'s selection) along with lines that
    /// `:m` moved, so mappings like `:m '>+1<CR>gv` keep the selection.
    fn shift_visual_marks(&mut self, first: usize, last: usize, delta: i64) {
        let shift = |p: &mut Pos| {
            if (first..=last).contains(&p.line) {
                p.line = (p.line as i64 + delta) as usize;
            }
        };
        for name in ['<', '>'] {
            if let Some(p) = self.marks.get_mut(&name) {
                shift(p);
            }
        }
        if let Some(v) = &mut self.last_visual {
            shift(&mut v.anchor);
            shift(&mut v.cursor);
        }
    }

    fn parse_address<'a>(&self, s: &'a str) -> Result<Option<(usize, &'a str)>, String> {
        Ok(self
            .parse_address_raw(s)?
            .map(|(l, rest)| (l.max(0) as usize, rest)))
    }

    fn parse_address_raw<'a>(&self, s: &'a str) -> Result<Option<(i64, &'a str)>, String> {
        let last = self.buffer.last_line() as i64;
        let mut chars = s.char_indices().peekable();
        let mut line: Option<i64> = None;
        let mut consumed = 0;
        match chars.peek() {
            Some((_, c)) if c.is_ascii_digit() => {
                let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
                consumed = digits.len();
                line = Some(digits.parse::<i64>().map_err(|e| e.to_string())? - 1);
            }
            Some((_, '.')) => {
                line = Some(self.cursor.line as i64);
                consumed = 1;
            }
            Some((_, '$')) => {
                line = Some(last);
                consumed = 1;
            }
            Some((_, '\'')) => {
                let mark = s[1..].chars().next().ok_or("E20: Mark not set")?;
                let pos = self.marks.get(&mark).ok_or("E20: Mark not set")?;
                line = Some(pos.line as i64);
                consumed = 1 + mark.len_utf8();
            }
            _ => {}
        }
        let mut rest = &s[consumed..];
        while let Some(sign) = rest.chars().next().filter(|c| *c == '+' || *c == '-') {
            let digits: String = rest[1..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            let amount: i64 = if digits.is_empty() {
                1
            } else {
                digits.parse().map_err(|_| "E16: Invalid range")?
            };
            let base = line.unwrap_or(self.cursor.line as i64);
            line = Some(if sign == '+' {
                base + amount
            } else {
                base - amount
            });
            rest = &rest[1 + digits.len()..];
        }
        match line {
            None => Ok(None),
            Some(l) if l > last || l < -1 => Err("E16: Invalid range".into()),
            Some(l) => Ok(Some((l, rest))),
        }
    }

    fn substitute(&mut self, first: usize, last: usize, args: &str) -> Result<(), String> {
        let (pattern, replacement, flags) = if args.is_empty() {
            self.last_substitute
                .clone()
                .ok_or("E35: No previous regular expression")?
        } else {
            parse_substitute(args)?
        };
        let pattern = if pattern.is_empty() {
            self.last_search
                .as_ref()
                .map(|s| s.pattern.clone())
                .ok_or("E35: No previous regular expression")?
        } else {
            pattern
        };
        self.last_substitute = Some((pattern.clone(), replacement.clone(), flags.clone()));
        let ignorecase = if flags.contains('i') {
            true
        } else if flags.contains('I') {
            false
        } else {
            self.options.ignorecase
        };
        let smartcase = self.options.smartcase && !flags.contains('i');
        let re = search::compile(&pattern, ignorecase, smartcase)
            .map_err(|e| format!("E486: Invalid pattern: {e}"))?;
        let rep = search::translate_replacement(&replacement);
        let global = flags.contains('g');

        let mut total = 0;
        let mut lines_changed = 0;
        let mut last_changed = None;
        for line in (first..=last).rev() {
            let text = self.buffer.line_string(line);
            let matches = re.find_iter(&text).count();
            if matches == 0 {
                continue;
            }
            let new = if global {
                re.replace_all(&text, rep.as_str())
            } else {
                re.replace(&text, rep.as_str())
            };
            total += if global { matches } else { 1 };
            lines_changed += 1;
            last_changed.get_or_insert(line);
            let mut parts = new.split('\n');
            self.buffer
                .replace_line(line, parts.next().unwrap_or("").chars().collect());
            let extra: Vec<Vec<char>> = parts.map(|p| p.chars().collect()).collect();
            if !extra.is_empty() {
                self.buffer.insert_lines(line + 1, extra);
            }
        }
        self.last_search = Some(LastSearch {
            pattern: pattern.clone(),
            forward: true,
        });
        self.hlsearch_active = true;
        let Some(line) = last_changed else {
            if flags.contains('e') {
                return Ok(());
            }
            return Err(format!("E486: Pattern not found: {pattern}"));
        };
        self.cursor = Pos::new(line, self.buffer.first_non_blank(line));
        if lines_changed > 1 {
            let s = if total == 1 { "" } else { "s" };
            self.set_message(format!("{total} substitution{s} on {lines_changed} lines"));
        }
        Ok(())
    }

    fn set_options(&mut self, args: &str) -> Result<(), String> {
        if args.is_empty() {
            let o = &self.options;
            self.set_message(format!(
                "{}number {}relativenumber {}ignorecase {}smartcase {}hlsearch {}expandtab tabstop={} shiftwidth={} scrolloff={}",
                if o.number { "" } else { "no" },
                if o.relativenumber { "" } else { "no" },
                if o.ignorecase { "" } else { "no" },
                if o.smartcase { "" } else { "no" },
                if o.hlsearch { "" } else { "no" },
                if o.expandtab { "" } else { "no" },
                o.tabstop,
                o.shiftwidth,
                o.scrolloff,
            ));
            return Ok(());
        }
        for arg in args.split_whitespace() {
            self.set_option(arg)?;
        }
        Ok(())
    }

    fn set_option(&mut self, arg: &str) -> Result<(), String> {
        if let Some((name, value)) = arg.split_once(['=', ':']) {
            if matches!(name, "clipboard" | "cb") {
                self.registers.use_system_clipboard = value.contains("unnamed");
                return Ok(());
            }
            let n: usize = value
                .parse()
                .map_err(|_| format!("E521: Number required after =: {arg}"))?;
            let o = &mut self.options;
            match canonical_option(name) {
                "tabstop" => o.tabstop = n.max(1),
                "shiftwidth" => o.shiftwidth = n.max(1),
                "scrolloff" => o.scrolloff = n,
                _ => return Err(format!("E518: Unknown option: {name}")),
            }
            return Ok(());
        }
        let (name, query) = match arg.strip_suffix('?') {
            Some(n) => (n, true),
            None => (arg, false),
        };
        let (name, toggle) = match name.strip_suffix('!') {
            Some(n) => (n, true),
            None => match name.strip_prefix("inv") {
                Some(n) => (n, true),
                None => (name, false),
            },
        };
        let (name, value) = match name.strip_prefix("no") {
            Some(n) if self.bool_option(n).is_some() => (n, false),
            _ => (name, true),
        };
        let full = canonical_option(name);
        let Some(slot) = self.bool_option(name) else {
            return match full {
                "tabstop" | "shiftwidth" | "scrolloff" if query => {
                    let o = &self.options;
                    let v = match full {
                        "tabstop" => o.tabstop,
                        "shiftwidth" => o.shiftwidth,
                        _ => o.scrolloff,
                    };
                    self.set_message(format!("{full}={v}"));
                    Ok(())
                }
                _ => Err(format!("E518: Unknown option: {name}")),
            };
        };
        if query {
            let current = *slot;
            self.set_message(format!("{}{full}", if current { "" } else { "no" }));
        } else if toggle {
            *slot = !*slot;
        } else {
            *slot = value;
            if full == "hlsearch" && value {
                self.hlsearch_active = true;
            }
        }
        Ok(())
    }

    fn bool_option(&mut self, name: &str) -> Option<&mut bool> {
        let o = &mut self.options;
        Some(match canonical_option(name) {
            "number" => &mut o.number,
            "relativenumber" => &mut o.relativenumber,
            "ignorecase" => &mut o.ignorecase,
            "smartcase" => &mut o.smartcase,
            "hlsearch" => &mut o.hlsearch,
            "incsearch" => &mut o.incsearch,
            "expandtab" => &mut o.expandtab,
            "autoindent" => &mut o.autoindent,
            _ => return None,
        })
    }
}

fn canonical_option(name: &str) -> &str {
    match name {
        "nu" => "number",
        "rnu" => "relativenumber",
        "ic" => "ignorecase",
        "scs" => "smartcase",
        "hls" => "hlsearch",
        "is" => "incsearch",
        "et" => "expandtab",
        "ai" => "autoindent",
        "ts" => "tabstop",
        "sw" => "shiftwidth",
        "so" => "scrolloff",
        other => other,
    }
}

fn path_arg(args: &str) -> Option<PathBuf> {
    (!args.is_empty()).then(|| PathBuf::from(expand_tilde(args)))
}

/// Split `/pattern/replacement/flags`, honouring escaped delimiters.
fn parse_substitute(args: &str) -> Result<(String, String, String), String> {
    let mut chars = args.chars();
    let delim = chars.next().ok_or("E35: No previous regular expression")?;
    if delim.is_alphanumeric() || delim == '\\' || delim == '"' || delim == '|' {
        return Err("E146: Regular expressions can't be delimited by letters".into());
    }
    let mut parts = vec![String::new()];
    let mut escaped = false;
    for c in chars {
        if escaped {
            if c != delim {
                parts.last_mut().unwrap().push('\\');
            }
            parts.last_mut().unwrap().push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == delim && parts.len() < 3 {
            parts.push(String::new());
        } else {
            parts.last_mut().unwrap().push(c);
        }
    }
    if escaped {
        parts.last_mut().unwrap().push('\\');
    }
    parts.resize(3, String::new());
    let flags = parts.pop().unwrap().trim().to_string();
    let replacement = parts.pop().unwrap();
    let pattern = parts.pop().unwrap();
    Ok((pattern, replacement, flags))
}
