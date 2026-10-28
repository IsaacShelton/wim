// Images attached to a message for the agent: chosen with a picker or
// dropped on the agents panel. They go to Claude as image content blocks.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatBytes } from '../image';

/** The image types Claude takes. */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface Attachment {
    name: string;
    mime: ImageMime;
    /** The image, in base64. */
    data: string;
    bytes: number;
}

/** The largest image Claude takes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The image's type, from its first bytes. */
function sniff(data: Buffer): ImageMime | undefined {
    if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) return 'image/png';
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return 'image/gif';
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return undefined;
}

/** An attachment for an image's bytes, or why it can't be one. */
export function imageAttachment(name: string, data: Buffer): Attachment | string {
    const mime = sniff(data);
    if (!mime) return `${name} isn't a PNG, JPEG, GIF or WebP image`;
    if (data.length > MAX_IMAGE_BYTES) return `${name} is too large (${formatBytes(data.length)}; at most ${formatBytes(MAX_IMAGE_BYTES)})`;
    return { name, mime, data: data.toString('base64'), bytes: data.length };
}

/** An attachment for an image file, or why it can't be one. */
export function readAttachment(file: string): Attachment | string {
    const name = path.basename(file);
    try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_IMAGE_BYTES) return `${name} is too large (${formatBytes(stat.size)}; at most ${formatBytes(MAX_IMAGE_BYTES)})`;
        return imageAttachment(name, fs.readFileSync(file));
    } catch (e) {
        return `Can't read ${name}: ${(e as Error).message}`;
    }
}
