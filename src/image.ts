// Image files: which files are images, and their format and size, read from
// their headers. The window loads and draws them; Node lays them out.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ImageInfo {
    /** `PNG`, `JPEG`, `WebP`, `GIF` or `BMP`. */
    format: string;
    width: number;
    height: number;
    bytes: number;
    /** Changes when the file does, so the window loads it again. */
    mtime: number;
}

const TYPES: Record<string, [format: string, mime: string]> = {
    png: ['PNG', 'image/png'],
    jpg: ['JPEG', 'image/jpeg'],
    jpeg: ['JPEG', 'image/jpeg'],
    webp: ['WebP', 'image/webp'],
    gif: ['GIF', 'image/gif'],
    bmp: ['BMP', 'image/bmp'],
};

function extension(file: string): string {
    return path.extname(file).slice(1).toLowerCase();
}

/** Whether `file` is shown as an image rather than as text. */
export function isImage(file: string | undefined): boolean {
    return file !== undefined && extension(file) in TYPES;
}

/** The MIME type to serve an image file with. */
export function imageMime(file: string): string | undefined {
    return TYPES[extension(file)]?.[1];
}

/** Width and height from an image's header, if it has a format Wim knows. */
export function imageSize(data: Buffer): [number, number] | undefined {
    // PNG: the IHDR chunk comes first.
    if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('ascii', 12, 16) === 'IHDR') {
        return [data.readUInt32BE(16), data.readUInt32BE(20)];
    }
    // GIF: the logical screen size.
    if (data.length >= 10 && data.toString('ascii', 0, 3) === 'GIF') {
        return [data.readUInt16LE(6), data.readUInt16LE(8)];
    }
    // BMP: the DIB header (height is negative for top-down images).
    if (data.length >= 26 && data.toString('ascii', 0, 2) === 'BM') {
        return [Math.abs(data.readInt32LE(18)), Math.abs(data.readInt32LE(22))];
    }
    // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
    if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = data.toString('ascii', 12, 16);
        if (chunk === 'VP8 ') return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
        if (chunk === 'VP8L') {
            const bits = data.readUInt32LE(21);
            return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
        }
        if (chunk === 'VP8X') return [data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1];
        return undefined;
    }
    // JPEG: the first start-of-frame marker.
    if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
        let i = 2;
        while (i + 9 < data.length) {
            if (data[i] !== 0xff) return undefined;
            const marker = data[i + 1];
            // Padding, and markers without a length.
            if (marker === 0xff) {
                i++;
                continue;
            }
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                i += 2;
                continue;
            }
            const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isFrame) return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)];
            i += 2 + data.readUInt16BE(i + 2);
        }
    }
    return undefined;
}

/** An image file's format and size. Throws if it can't be read; a size of 0
 * means the header wasn't understood. */
export function readImageInfo(file: string): ImageInfo {
    const stat = fs.statSync(file);
    const data = fs.readFileSync(file);
    const [width, height] = imageSize(data) ?? [0, 0];
    return { format: TYPES[extension(file)]?.[0] ?? 'Image', width, height, bytes: stat.size, mtime: stat.mtimeMs };
}

/** `120 KB` and the like. */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The window's address for an image file (the window adds the session
 * token). */
export function imageUrl(file: string, info: ImageInfo): string {
    return `/media?p=${encodeURIComponent(file)}&v=${Math.round(info.mtime)}`;
}
