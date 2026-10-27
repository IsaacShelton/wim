// Errors reported to the user on the command line, like Vim's `E…` messages.

export class EditorError extends Error {}

export function fail(message: string): never {
    throw new EditorError(message);
}

/** For images and sounds, which are shown or played, not edited. */
export const READONLY = "E21: Cannot make changes, 'modifiable' is off";
