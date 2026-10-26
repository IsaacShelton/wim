// JSON-RPC 2.0 over a pair of streams, framed with `Content-Length` headers
// as the Language Server Protocol does.

import type { Readable, Writable } from 'node:stream';

export class ResponseError extends Error {
    constructor(
        readonly code: number,
        message: string,
    ) {
        super(message);
    }
}

/** The server dropped a request because the document changed or the client
 * cancelled it: not worth reporting. */
export function isStale(e: unknown): boolean {
    return e instanceof ResponseError && (e.code === -32800 || e.code === -32801);
}

interface Pending {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
}

interface Message {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
}

export class RpcConnection {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private input = Buffer.alloc(0);
    private closed = false;

    /** Handles requests from the other side; the result is sent back. */
    onRequest: (method: string, params: unknown) => unknown = () => {
        throw new ResponseError(-32601, 'Method not found');
    };
    onNotification: (method: string, params: unknown) => void = () => {};

    constructor(
        readable: Readable,
        private readonly writable: Writable,
    ) {
        readable.on('data', (chunk: Buffer) => this.receive(chunk));
        readable.on('close', () => this.close());
        writable.on('error', () => this.close());
    }

    request<T>(method: string, params: unknown): Promise<T> {
        if (this.closed) return Promise.reject(new Error('The language server has stopped'));
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method: string, params: unknown): void {
        if (!this.closed) this.write({ jsonrpc: '2.0', method, params });
    }

    /** Fail every outstanding request; nothing more is sent. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error('The language server has stopped'));
        this.pending.clear();
    }

    private write(msg: object): void {
        if (this.closed) return;
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        this.writable.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.writable.write(body);
    }

    private receive(chunk: Buffer): void {
        this.input = Buffer.concat([this.input, chunk]);
        for (;;) {
            const headerEnd = this.input.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const header = this.input.subarray(0, headerEnd).toString('ascii');
            const m = /Content-Length: *(\d+)/i.exec(header);
            if (!m) {
                // Not a header we understand: skip it.
                this.input = this.input.subarray(headerEnd + 4);
                continue;
            }
            const start = headerEnd + 4;
            const end = start + Number(m[1]);
            if (this.input.length < end) return;
            const body = this.input.subarray(start, end).toString('utf8');
            this.input = this.input.subarray(end);
            let msg: Message;
            try {
                msg = JSON.parse(body) as Message;
            } catch {
                continue;
            }
            this.dispatch(msg);
        }
    }

    private dispatch(msg: Message): void {
        if (msg.method === undefined) {
            const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
            if (!p) return;
            this.pending.delete(msg.id as number);
            if (msg.error) p.reject(new ResponseError(msg.error.code, msg.error.message));
            else p.resolve(msg.result ?? null);
            return;
        }
        if (msg.id === undefined) {
            this.onNotification(msg.method, msg.params);
            return;
        }
        const id = msg.id;
        Promise.resolve()
            .then(() => this.onRequest(msg.method!, msg.params))
            .then(
                (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
                (e: unknown) => {
                    const code = e instanceof ResponseError ? e.code : -32603;
                    const message = e instanceof Error ? e.message : String(e);
                    this.write({ jsonrpc: '2.0', id, error: { code, message } });
                },
            );
    }
}
