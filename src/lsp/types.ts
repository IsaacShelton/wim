// The parts of the Language Server Protocol's types that Wim uses.

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface Location {
    uri: string;
    range: Range;
}

export interface LocationLink {
    targetUri: string;
    targetRange: Range;
    targetSelectionRange: Range;
}

export const enum Severity {
    Error = 1,
    Warning = 2,
    Information = 3,
    Hint = 4,
}

export interface Diagnostic {
    range: Range;
    severity?: Severity;
    code?: number | string;
    source?: string;
    message: string;
}

export interface TextEdit {
    range: Range;
    newText: string;
}

export interface TextDocumentEdit {
    textDocument: { uri: string; version?: number | null };
    edits: TextEdit[];
}

export interface CreateFile {
    kind: 'create';
    uri: string;
    options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface RenameFile {
    kind: 'rename';
    oldUri: string;
    newUri: string;
    options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface DeleteFile {
    kind: 'delete';
    uri: string;
    options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
}

export interface WorkspaceEdit {
    changes?: Record<string, TextEdit[]>;
    documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[];
}

export interface Command {
    title: string;
    command: string;
    arguments?: unknown[];
}

export interface CodeAction {
    title: string;
    kind?: string;
    diagnostics?: Diagnostic[];
    isPreferred?: boolean;
    disabled?: { reason: string };
    edit?: WorkspaceEdit;
    command?: Command;
    data?: unknown;
}

export interface MarkupContent {
    kind: 'plaintext' | 'markdown';
    value: string;
}

/** Deprecated hover contents, still sent by some servers. */
export type MarkedString = string | { language: string; value: string };

export interface Hover {
    contents: MarkupContent | MarkedString | MarkedString[];
    range?: Range;
}

export const enum CompletionItemKind {
    Text = 1,
    Method = 2,
    Function = 3,
    Constructor = 4,
    Field = 5,
    Variable = 6,
    Class = 7,
    Interface = 8,
    Module = 9,
    Property = 10,
    Unit = 11,
    Value = 12,
    Enum = 13,
    Keyword = 14,
    Snippet = 15,
    Color = 16,
    File = 17,
    Reference = 18,
    Folder = 19,
    EnumMember = 20,
    Constant = 21,
    Struct = 22,
    Event = 23,
    Operator = 24,
    TypeParameter = 25,
}

export const COMPLETION_KINDS = [
    '', 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module',
    'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder',
    'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter',
] as const;

export const enum InsertTextFormat {
    PlainText = 1,
    Snippet = 2,
}

export interface CompletionItem {
    label: string;
    labelDetails?: { detail?: string; description?: string };
    kind?: CompletionItemKind;
    detail?: string;
    sortText?: string;
    filterText?: string;
    insertText?: string;
    insertTextFormat?: InsertTextFormat;
    textEdit?: TextEdit | { newText: string; insert: Range; replace: Range };
    additionalTextEdits?: TextEdit[];
    command?: Command;
    data?: unknown;
}

export interface CompletionList {
    isIncomplete: boolean;
    items: CompletionItem[];
}

export const SYMBOL_KINDS = [
    '', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor',
    'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object',
    'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter',
] as const;

export interface DocumentSymbol {
    name: string;
    detail?: string;
    kind: number;
    range: Range;
    selectionRange: Range;
    children?: DocumentSymbol[];
}

export interface SymbolInformation {
    name: string;
    kind: number;
    location: Location | { uri: string };
    containerName?: string;
}

export interface ParameterInformation {
    /** The parameter's text, or where it is in the signature's label (UTF-16
     * offsets). */
    label: string | [number, number];
    documentation?: string | MarkupContent;
}

export interface SignatureInformation {
    label: string;
    documentation?: string | MarkupContent;
    parameters?: ParameterInformation[];
    activeParameter?: number;
}

export interface SignatureHelp {
    signatures: SignatureInformation[];
    activeSignature?: number;
    activeParameter?: number;
}

export interface DocumentHighlight {
    range: Range;
}

export interface ProgressValue {
    kind: 'begin' | 'report' | 'end';
    title?: string;
    message?: string;
    percentage?: number;
}

export interface ServerCapabilities {
    positionEncoding?: string;
    textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
    completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
    hoverProvider?: unknown;
    signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
    semanticTokensProvider?: {
        legend: { tokenTypes: string[]; tokenModifiers: string[] };
        full?: boolean | { delta?: boolean };
    };
    definitionProvider?: unknown;
    declarationProvider?: unknown;
    typeDefinitionProvider?: unknown;
    implementationProvider?: unknown;
    referencesProvider?: unknown;
    documentHighlightProvider?: unknown;
    documentSymbolProvider?: unknown;
    workspaceSymbolProvider?: unknown;
    codeActionProvider?: boolean | { resolveProvider?: boolean };
    documentFormattingProvider?: unknown;
    renameProvider?: unknown;
    executeCommandProvider?: { commands: string[] };
}
