/**
 * Bidirectional JSON-RPC 2.0 peer over newline-delimited JSON.
 *
 * Both the host (supervising a plugin process) and the plugin SDK use this
 * class, so the protocol behaviour is identical on both ends. It is
 * deliberately dependency-free: the SDK bundles it into every plugin.
 */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  PermissionDenied: -32001,
  Timeout: -32002,
  Cancelled: -32003,
  IncompatibleProtocol: -32004,
  InvalidRegistration: -32005,
  QuotaExceeded: -32006,
  InvalidOutput: -32007,
  NotActive: -32008,
  PluginError: -32009,
} as const;

export const RpcErrorName: Record<number, string> = Object.fromEntries(Object.entries(RpcErrorCode).map(([k, v]) => [v, k]));

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
  get codeName(): string {
    return RpcErrorName[this.code] ?? "Error";
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.data === undefined ? {} : { data: this.data }) };
  }
}

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** 8MB frame limit (report 7.1). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface LineTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

/** Frames a readable/writable byte stream pair as NDJSON lines. */
export function ndjsonTransport(
  readable: NodeJS.ReadableStream,
  writable: NodeJS.WritableStream,
  opts: { maxLineBytes?: number; onOversize?: (bytes: number) => void } = {},
): LineTransport {
  const max = opts.maxLineBytes ?? MAX_FRAME_BYTES;
  let buf = "";
  let closed = false;
  const lineCbs: Array<(l: string) => void> = [];
  const closeCbs: Array<(r: string) => void> = [];
  const fireClose = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb(reason);
  };
  readable.setEncoding?.("utf8");
  readable.on("data", (chunk: string | Buffer) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.length > max) opts.onOversize?.(line.length);
      else if (line.trim()) for (const cb of lineCbs) cb(line);
      i = buf.indexOf("\n");
    }
    if (buf.length > max) {
      opts.onOversize?.(buf.length);
      buf = "";
    }
  });
  readable.on("end", () => fireClose("eof"));
  readable.on("close", () => fireClose("closed"));
  readable.on("error", (e: Error) => fireClose(`error: ${e.message}`));
  writable.on?.("error", () => fireClose("write error"));
  return {
    send(line) {
      if (closed) return;
      try {
        writable.write(`${line}\n`);
      } catch {
        fireClose("write failed");
      }
    },
    onLine(cb) {
      lineCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close() {
      try {
        (writable as NodeJS.WritableStream & { end?: () => void }).end?.();
      } catch {
        // ignore
      }
      fireClose("closed by peer");
    },
  };
}

export interface RequestContext {
  id: JsonRpcId;
  signal: AbortSignal;
  progress(value: unknown): void;
}

export type RequestHandler = (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (value: unknown) => void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  onProgress?: (value: unknown) => void;
  method: string;
}

export interface PeerOptions {
  /** Called for every message sent ("out") or received ("in"); used by the inspector. */
  trace?: (direction: "in" | "out", message: JsonRpcMessage) => void;
  /** Lines that are not JSON-RPC (e.g. a stray console.log). They are reported, never fatal. */
  onInvalidLine?: (line: string, reason: string) => void;
  onClose?: (reason: string) => void;
  /** Max concurrently executing incoming requests. */
  maxConcurrentIncoming?: number;
}

export class RpcPeer {
  private readonly transport: LineTransport;
  private readonly opts: PeerOptions;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly incoming = new Map<JsonRpcId, AbortController>();
  private nextId = 1;
  private closedReason: string | null = null;

  constructor(transport: LineTransport, opts: PeerOptions = {}) {
    this.transport = transport;
    this.opts = opts;
    transport.onLine((line) => this.receive(line));
    transport.onClose((reason) => this.handleClose(reason));
    this.onNotification("$/cancelRequest", (p) => {
      const id = (p as { id?: JsonRpcId })?.id;
      if (id !== undefined) this.incoming.get(id)?.abort(new RpcError(RpcErrorCode.Cancelled, "request cancelled by peer"));
    });
    this.onNotification("$/progress", (p) => {
      const { id, value } = (p ?? {}) as { id?: JsonRpcId; value?: unknown };
      if (id !== undefined) this.pending.get(id)?.onProgress?.(value);
    });
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get incomingCount(): number {
    return this.incoming.size;
  }

  handle(method: string, handler: RequestHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  onNotification(method: string, handler: NotificationHandler): this {
    this.notificationHandlers.set(method, handler);
    return this;
  }

  private send(msg: JsonRpcMessage): void {
    let line = JSON.stringify(msg);
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      const bytes = Buffer.byteLength(line);
      if ("id" in msg && !("method" in msg) && msg.id !== null) {
        // An oversized result becomes an explicit error instead of a frame the peer would drop.
        msg = { jsonrpc: "2.0", id: msg.id, error: { code: RpcErrorCode.InvalidOutput, message: `response too large: ${bytes} bytes (limit ${MAX_FRAME_BYTES})` } };
        line = JSON.stringify(msg);
      } else throw new RpcError(RpcErrorCode.QuotaExceeded, `message too large: ${bytes} bytes (limit ${MAX_FRAME_BYTES})`);
    }
    this.opts.trace?.("out", msg);
    this.transport.send(line);
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  request<T = unknown>(method: string, params?: unknown, opts: RequestOptions = {}): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new RpcError(RpcErrorCode.NotActive, `connection closed: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress, method };
      const cancel = (err: RpcError) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        this.notify("$/cancelRequest", { id });
        reject(err);
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        entry.timer = setTimeout(() => cancel(new RpcError(RpcErrorCode.Timeout, `${method} timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
      }
      if (opts.signal) {
        if (opts.signal.aborted) return cancel(new RpcError(RpcErrorCode.Cancelled, `${method} cancelled`));
        opts.signal.addEventListener("abort", () => cancel(new RpcError(RpcErrorCode.Cancelled, `${method} cancelled`)), { once: true });
      }
      this.pending.set(id, entry);
      try {
        this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      } catch (err) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  private receive(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.opts.onInvalidLine?.(line, "not JSON");
      return;
    }
    if (!msg || typeof msg !== "object" || (msg as { jsonrpc?: string }).jsonrpc !== "2.0") {
      this.opts.onInvalidLine?.(line, "not a JSON-RPC 2.0 message");
      return;
    }
    this.opts.trace?.("in", msg);
    if ("method" in msg && typeof msg.method === "string") {
      if ("id" in msg && msg.id !== undefined && msg.id !== null) void this.dispatchRequest(msg as JsonRpcRequest);
      else this.dispatchNotification(msg as JsonRpcNotification);
      return;
    }
    if ("id" in msg) {
      const res = msg as JsonRpcResponse;
      const p = res.id === null ? undefined : this.pending.get(res.id);
      if (!p || res.id === null) return;
      this.pending.delete(res.id);
      if (p.timer) clearTimeout(p.timer);
      if (res.error) p.reject(new RpcError(res.error.code, res.error.message, res.error.data));
      else p.resolve(res.result);
    }
  }

  private dispatchNotification(msg: JsonRpcNotification): void {
    const h = this.notificationHandlers.get(msg.method);
    if (!h) return;
    try {
      h(msg.params);
    } catch {
      // notification handlers must not break the connection
    }
  }

  private async dispatchRequest(msg: JsonRpcRequest): Promise<void> {
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: RpcErrorCode.MethodNotFound, message: `method not found: ${msg.method}` } });
      return;
    }
    const max = this.opts.maxConcurrentIncoming ?? 64;
    if (this.incoming.size >= max) {
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: RpcErrorCode.QuotaExceeded, message: `too many concurrent requests (max ${max})` } });
      return;
    }
    const ctrl = new AbortController();
    this.incoming.set(msg.id, ctrl);
    try {
      const result = await handler(msg.params, {
        id: msg.id,
        signal: ctrl.signal,
        progress: (value) => this.notify("$/progress", { id: msg.id, value }),
      });
      if (!this.closed) this.send({ jsonrpc: "2.0", id: msg.id, result: result === undefined ? null : result });
    } catch (err) {
      const e = err as { code?: unknown; message?: string; data?: unknown };
      const code = typeof e?.code === "number" ? e.code : RpcErrorCode.InternalError;
      if (!this.closed) this.send({ jsonrpc: "2.0", id: msg.id, error: { code, message: e?.message ?? String(err), ...(e?.data === undefined ? {} : { data: e.data }) } });
    } finally {
      this.incoming.delete(msg.id);
    }
  }

  private handleClose(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(RpcErrorCode.NotActive, `connection closed while waiting for ${p.method}: ${reason}`));
      this.pending.delete(id);
    }
    for (const c of this.incoming.values()) c.abort(new RpcError(RpcErrorCode.Cancelled, "connection closed"));
    this.opts.onClose?.(reason);
  }

  close(reason = "closed"): void {
    this.transport.close();
    this.handleClose(reason);
  }
}
