// Sound files: which files are sounds, and the player. The window plays the
// sound (with an <audio> element) and reports how far it has got; Wim keeps
// the player's state, draws its controls and tells the window what to do.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AudioCommand, AudioReport } from './protocol';

export interface AudioInfo {
    /** `MP3`, `WAV`, `FLAC` and so on. */
    format: string;
    bytes: number;
    /** Changes when the file does, so the window loads it again. */
    mtime: number;
}

const TYPES: Record<string, [format: string, mime: string]> = {
    mp3: ['MP3', 'audio/mpeg'],
    wav: ['WAV', 'audio/wav'],
    flac: ['FLAC', 'audio/flac'],
    ogg: ['Ogg', 'audio/ogg'],
    oga: ['Ogg', 'audio/ogg'],
    opus: ['Opus', 'audio/ogg'],
    m4a: ['AAC', 'audio/mp4'],
    aac: ['AAC', 'audio/aac'],
    weba: ['WebM', 'audio/webm'],
};

function extension(file: string): string {
    return path.extname(file).slice(1).toLowerCase();
}

/** Whether `file` is played rather than edited. */
export function isAudio(file: string | undefined): boolean {
    return file !== undefined && extension(file) in TYPES;
}

/** The MIME type to serve a sound file with. */
export function audioMime(file: string): string | undefined {
    return TYPES[extension(file)]?.[1];
}

/** Throws if the file can't be read. */
export function readAudioInfo(file: string): AudioInfo {
    const stat = fs.statSync(file);
    return { format: TYPES[extension(file)]?.[0] ?? 'Audio', bytes: stat.size, mtime: stat.mtimeMs };
}

/** The window's address for a sound file (the window adds the session
 * token). */
export function audioUrl(file: string, info: AudioInfo): string {
    return `/media?p=${encodeURIComponent(file)}&v=${Math.round(info.mtime)}`;
}

/** `1:05`, or `1:02:05` past an hour. */
export function formatTime(seconds: number): string {
    const s = Math.max(Math.floor(seconds), 0);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** How far seeking and volume keys go. */
export const SEEK_STEP = 5;
export const VOLUME_STEP = 0.1;

/** The one sound that can be playing, and its state as last reported. */
export class AudioPlayer {
    /** The file loaded in the window, if any. */
    file: string | undefined;
    private src: string | undefined;
    time = 0;
    duration = 0;
    playing = false;
    volume = 1;
    /** Before muting, to go back to. */
    private unmuted = 1;
    error: string | undefined;

    constructor(
        private readonly send: (cmd: AudioCommand) => void,
        private readonly refresh: () => void,
    ) {}

    /** Get `file` ready to play (without playing it), unless another sound is
     * playing. */
    show(file: string, info: AudioInfo): void {
        if (this.file === file || this.playing) return;
        this.load(file, info);
    }

    private load(file: string, info: AudioInfo): void {
        this.file = file;
        this.src = audioUrl(file, info);
        this.time = 0;
        this.duration = 0;
        this.playing = false;
        this.error = undefined;
        this.send({ op: 'load', src: this.src });
    }

    /** Play `file` (from where it was), or pause it if it is playing. */
    toggle(file: string, info: AudioInfo): void {
        if (this.file !== file) this.load(file, info);
        // Shown at once; the window's report confirms it.
        this.playing = !this.playing;
        this.send({ op: this.playing ? 'play' : 'pause' });
    }

    /** Seek to `time` seconds into the current file. */
    seek(time: number): void {
        if (this.file === undefined) return;
        this.time = Math.min(Math.max(time, 0), this.duration || Infinity);
        this.send({ op: 'seek', time: this.time });
    }

    setVolume(volume: number): void {
        this.volume = Math.min(Math.max(Math.round(volume * 100) / 100, 0), 1);
        if (this.volume > 0) this.unmuted = this.volume;
        this.send({ op: 'volume', volume: this.volume });
    }

    toggleMute(): void {
        this.setVolume(this.volume > 0 ? 0 : this.unmuted || 1);
    }

    /** Stop playing `file` (its buffer closed). */
    stop(file: string): void {
        if (this.file !== file) return;
        this.send({ op: 'stop' });
        this.file = undefined;
        this.src = undefined;
        this.playing = false;
        this.time = 0;
        this.duration = 0;
    }

    /** The window reports on its <audio> element. */
    update(report: AudioReport): void {
        if (report.src !== this.src) return;
        this.time = report.time;
        this.duration = report.duration;
        this.playing = !report.paused;
        this.volume = report.volume;
        this.error = report.error;
        this.refresh();
    }
}
