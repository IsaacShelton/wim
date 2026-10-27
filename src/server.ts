// A local HTTP server for the window's page, and a minimal WebSocket server
// (RFC 6455, text frames only) that carries input and frames between the
// window and the editor. Only connections bearing the session token are
// accepted, and only from this machine.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';

import { imageMime } from './image';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Larger messages than this from the window are refused. */
const MAX_MESSAGE = 1 << 20;

/** One WebSocket connection. Emits `message` (string) and `close`. */
export class WebSocketConnection extends EventEmitter {
    private buffered = Buffer.alloc(0);
    private fragments: Buffer[] = [];
    private closed = false;

    constructor(private readonly socket: Duplex) {
        super();
        socket.on('data', (chunk: Buffer) => this.receive(chunk));
        socket.on('close', () => this.finish());
        socket.on('error', () => this.finish());
    }

    send(text: string): void {
        if (this.closed) return;
        this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
    }

    close(): void {
        if (this.closed) return;
        this.socket.write(frame(0x8, Buffer.alloc(0)));
        this.socket.end();
        this.finish();
    }

    private finish(): void {
        if (this.closed) return;
        this.closed = true;
        this.emit('close');
    }

    private receive(chunk: Buffer): void {
        this.buffered = Buffer.concat([this.buffered, chunk]);
        for (;;) {
            const b = this.buffered;
            if (b.length < 2) return;
            const fin = (b[0] & 0x80) !== 0;
            const opcode = b[0] & 0x0f;
            const masked = (b[1] & 0x80) !== 0;
            let len = b[1] & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (b.length < 4) return;
                len = b.readUInt16BE(2);
                offset = 4;
            } else if (len === 127) {
                if (b.length < 10) return;
                const big = b.readBigUInt64BE(2);
                if (big > BigInt(MAX_MESSAGE)) return this.close();
                len = Number(big);
                offset = 10;
            }
            if (len > MAX_MESSAGE) return this.close();
            const maskLen = masked ? 4 : 0;
            if (b.length < offset + maskLen + len) return;
            const payload = Buffer.from(b.subarray(offset + maskLen, offset + maskLen + len));
            if (masked) {
                const mask = b.subarray(offset, offset + 4);
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            }
            this.buffered = b.subarray(offset + maskLen + len);
            this.handleFrame(fin, opcode, payload);
            if (this.closed) return;
        }
    }

    private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
        switch (opcode) {
            case 0x0: // continuation
            case 0x1: // text
                this.fragments.push(payload);
                if (fin) {
                    const text = Buffer.concat(this.fragments).toString('utf8');
                    this.fragments = [];
                    this.emit('message', text);
                }
                break;
            case 0x8:
                this.close();
                break;
            case 0x9:
                this.socket.write(frame(0xa, payload));
                break;
            default:
                // Binary frames and pongs are ignored.
                break;
        }
    }
}

function frame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
        header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

export interface ServerOptions {
    /** A Nerd Font to serve for file icons. */
    fontPath?: string;
    onConnection: (conn: WebSocketConnection) => void;
}

export interface Server {
    /** The page's address, including the session token. */
    url: string;
    close(): void;
}

export function startServer(opts: ServerOptions): Promise<Server> {
    const token = randomBytes(18).toString('base64url');
    const clientScript = path.join(__dirname, '..', 'web', 'ui', 'client.js');
    let host = '';

    const server = http.createServer((req, res) => {
        if (req.headers.host !== host) {
            res.writeHead(403).end();
            return;
        }
        const url = new URL(req.url ?? '/', `http://${host}`);
        const send = (status: number, type: string, body: string | Buffer): void => {
            res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
            res.end(body);
        };
        if (url.pathname === '/') {
            send(200, 'text/html; charset=utf-8', page(opts.fontPath !== undefined));
        } else if (url.pathname === '/client.js') {
            fs.readFile(clientScript, (err, data) =>
                err ? send(500, 'text/plain', 'Wim is not built: run `npm run build`.') : send(200, 'text/javascript', data),
            );
        } else if (url.pathname === '/image') {
            // Image files the editor shows, for this session only.
            const file = url.searchParams.get('p') ?? '';
            const mime = imageMime(file);
            if (url.searchParams.get('t') !== token || mime === undefined || !path.isAbsolute(file)) {
                send(403, 'text/plain', 'Forbidden');
                return;
            }
            fs.readFile(file, (err, data) => (err ? send(404, 'text/plain', '') : send(200, mime, data)));
        } else if (url.pathname === '/icons-font' && opts.fontPath) {
            const type = opts.fontPath.toLowerCase().endsWith('.otf') ? 'font/otf' : 'font/ttf';
            fs.readFile(opts.fontPath, (err, data) => (err ? send(404, 'text/plain', '') : send(200, type, data)));
        } else {
            send(404, 'text/plain', 'Not found');
        }
    });

    server.on('upgrade', (req: http.IncomingMessage, socket: Duplex) => {
        const url = new URL(req.url ?? '/', `http://${host}`);
        const key = req.headers['sec-websocket-key'];
        if (
            req.headers.host !== host ||
            url.pathname !== '/ws' ||
            url.searchParams.get('t') !== token ||
            typeof key !== 'string' ||
            (req.headers.upgrade ?? '').toLowerCase() !== 'websocket'
        ) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        const accept = createHash('sha1')
            .update(key + WS_GUID)
            .digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        opts.onConnection(new WebSocketConnection(socket));
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address === null || typeof address === 'string') {
                reject(new Error('could not start the server'));
                return;
            }
            host = `127.0.0.1:${address.port}`;
            resolve({
                url: `http://${host}/?t=${token}`,
                close: () => {
                    server.closeAllConnections();
                    server.close();
                },
            });
        });
    });
}

/** The window's page: a full-window canvas driven by `client.js`. */
function page(hasIconFont: boolean): string {
    const fontFace = hasIconFont ? "@font-face { font-family: 'WimIcons'; src: url('/icons-font'); }" : '';
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wim</title>
<style>
${fontFace}
html, body { margin: 0; height: 100%; overflow: hidden; background: #282c34; }
canvas { display: block; width: 100vw; height: 100vh; cursor: text; }
</style>
</head>
<body>
<canvas id="wim" data-icons="${hasIconFont ? '1' : ''}"></canvas>
<script type="module" src="/client.js"></script>
</body>
</html>
`;
}
