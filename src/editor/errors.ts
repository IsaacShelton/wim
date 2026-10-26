// Errors reported to the user on the command line, like Vim's `E…` messages.

export class EditorError extends Error {}

export function fail(message: string): never {
    throw new EditorError(message);
}
