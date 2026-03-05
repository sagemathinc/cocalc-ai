import type {
  BrowserNetworkTraceDirection,
  BrowserNetworkTraceEvent,
  BrowserNetworkTracePhase,
  BrowserNetworkTraceProtocol,
  BrowserRuntimeEvent,
  BrowserRuntimeEventKind,
  BrowserRuntimeEventLevel,
  BrowserSessionServiceApi,
} from "@cocalc/conat/service/browser-session";
import {
  onConatTrace,
  type ConatTraceEvent,
} from "@cocalc/conat/core/client";
import {
  safeStringifyForRuntimeLog,
  truncateRuntimeMessage,
} from "./common-utils";

const MAX_RUNTIME_EVENTS = 5_000;
const MAX_NETWORK_TRACE_EVENTS = 50_000;
const MAX_NETWORK_TRACE_PREVIEW_CHARS = 4_000;
const MAX_NETWORK_TRACE_INTERNAL_SUBJECTS = 2_000;
const NETWORK_TRACE_INTERNAL_SUBJECT_TTL_MS = 10 * 60 * 1000;
const ALL_NETWORK_TRACE_PROTOCOLS: BrowserNetworkTraceProtocol[] = [
  "conat",
  "http",
  "ws",
];
const INTERNAL_TRACE_METHODS = new Set<string>([
  "listNetworkTrace",
  "configureNetworkTrace",
  "clearNetworkTrace",
]);

type PendingNetworkTraceEvent = Omit<
  BrowserNetworkTraceEvent,
  "seq" | "ts" | "url"
>;

type ConfigureNetworkTraceOpts = Parameters<
  BrowserSessionServiceApi["configureNetworkTrace"]
>[0];
type ConfigureNetworkTraceResult = Awaited<
  ReturnType<BrowserSessionServiceApi["configureNetworkTrace"]>
>;
type ListNetworkTraceOpts = Parameters<BrowserSessionServiceApi["listNetworkTrace"]>[0];
type ListNetworkTraceResult = Awaited<
  ReturnType<BrowserSessionServiceApi["listNetworkTrace"]>
>;
type ListRuntimeEventsOpts = Parameters<BrowserSessionServiceApi["listRuntimeEvents"]>[0];
type ListRuntimeEventsResult = Awaited<
  ReturnType<BrowserSessionServiceApi["listRuntimeEvents"]>
>;
type ClearNetworkTraceResult = Awaited<
  ReturnType<BrowserSessionServiceApi["clearNetworkTrace"]>
>;

export type BrowserRuntimeObservability = {
  configureNetworkTrace: (
    opts: ConfigureNetworkTraceOpts,
  ) => ConfigureNetworkTraceResult;
  listNetworkTrace: (opts: ListNetworkTraceOpts) => ListNetworkTraceResult;
  clearNetworkTrace: () => ClearNetworkTraceResult;
  listRuntimeEvents: (opts: ListRuntimeEventsOpts) => ListRuntimeEventsResult;
  reset: () => void;
  onStart: () => void;
  stop: () => void;
};

export function createBrowserRuntimeObservability(): BrowserRuntimeObservability {
  const runtimeEvents: BrowserRuntimeEvent[] = [];
  let runtimeEventSeq = 0;
  let runtimeEventsDropped = 0;
  const networkTraceEvents: BrowserNetworkTraceEvent[] = [];
  let networkTraceSeq = 0;
  let networkTraceDropped = 0;
  let stopConatTraceListener: (() => void) | undefined;
  const internalTraceReplySubjects = new Map<string, number>();

  const networkTraceConfig: {
    enabled: boolean;
    include_decoded: boolean;
    include_internal: boolean;
    protocols: BrowserNetworkTraceProtocol[];
    max_events: number;
    max_preview_chars: number;
    subject_prefixes: string[];
    addresses: string[];
  } = {
    enabled: false,
    include_decoded: false,
    include_internal: false,
    protocols: [...ALL_NETWORK_TRACE_PROTOCOLS],
    max_events: 5_000,
    max_preview_chars: MAX_NETWORK_TRACE_PREVIEW_CHARS,
    subject_prefixes: [],
    addresses: [],
  };

  const appendRuntimeEvent = ({
    kind,
    level,
    message,
    source,
    line,
    column,
    stack,
  }: {
    kind: BrowserRuntimeEventKind;
    level: BrowserRuntimeEventLevel;
    message: string;
    source?: string;
    line?: number;
    column?: number;
    stack?: string;
  }): void => {
    const text = truncateRuntimeMessage(`${message ?? ""}`.trim() || "<empty>");
    runtimeEventSeq += 1;
    runtimeEvents.push({
      seq: runtimeEventSeq,
      ts: new Date().toISOString(),
      kind,
      level,
      message: text,
      ...(source ? { source } : {}),
      ...(line != null ? { line } : {}),
      ...(column != null ? { column } : {}),
      ...(stack ? { stack: truncateRuntimeMessage(stack) } : {}),
      ...(typeof location !== "undefined" && location.href
        ? { url: `${location.href}` }
        : {}),
    });
    if (runtimeEvents.length > MAX_RUNTIME_EVENTS) {
      const drop = runtimeEvents.length - MAX_RUNTIME_EVENTS;
      runtimeEvents.splice(0, drop);
      runtimeEventsDropped += drop;
    }
  };

  const installRuntimeCapture = (): void => {
    const g = globalThis as any;
    g.__cocalc_browser_runtime_capture_emit = appendRuntimeEvent;
    if (g.__cocalc_browser_runtime_capture_installed) {
      return;
    }
    g.__cocalc_browser_runtime_capture_installed = true;

    const originalConsole = {
      trace: console.trace,
      debug: console.debug,
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const bindMethod = (
      name: keyof typeof originalConsole,
    ): ((...args: any[]) => void) => {
      const original = originalConsole[name];
      if (typeof original !== "function") {
        return (..._args: any[]) => {};
      }
      return (...args: any[]) => {
        try {
          const level = name as BrowserRuntimeEventLevel;
          const message = args
            .map((x) => safeStringifyForRuntimeLog(x))
            .filter((x) => x.length > 0)
            .join(" ");
          const emit = (globalThis as any).__cocalc_browser_runtime_capture_emit;
          emit?.({
            kind: "console",
            level,
            message,
          });
        } catch {
          // ignore capture failures
        }
        try {
          (original as any).apply(console, args);
        } catch {
          // ignore console errors
        }
      };
    };
    console.trace = bindMethod("trace");
    console.debug = bindMethod("debug");
    console.log = bindMethod("log");
    console.info = bindMethod("info");
    console.warn = bindMethod("warn");
    console.error = bindMethod("error");

    globalThis.addEventListener("error", (event: ErrorEvent) => {
      try {
        const emit = (globalThis as any).__cocalc_browser_runtime_capture_emit;
        emit?.({
          kind: "uncaught_error",
          level: "error",
          message:
            `${event?.message ?? ""}`.trim() ||
            safeStringifyForRuntimeLog((event as any)?.error),
          source: `${event?.filename ?? ""}`.trim() || undefined,
          line:
            Number.isFinite(Number(event?.lineno ?? NaN))
              ? Number(event?.lineno)
              : undefined,
          column:
            Number.isFinite(Number(event?.colno ?? NaN))
              ? Number(event?.colno)
              : undefined,
          stack: `${(event as any)?.error?.stack ?? ""}`.trim() || undefined,
        });
      } catch {
        // ignore capture failures
      }
    });
    globalThis.addEventListener(
      "unhandledrejection",
      (event: PromiseRejectionEvent) => {
        try {
          const reason = (event as any)?.reason;
          const message = safeStringifyForRuntimeLog(reason);
          const emit = (globalThis as any).__cocalc_browser_runtime_capture_emit;
          emit?.({
            kind: "unhandled_rejection",
            level: "error",
            message: message.trim() || "<unhandled rejection>",
            stack:
              typeof reason === "object" && reason != null
                ? `${(reason as any)?.stack ?? ""}`.trim() || undefined
                : undefined,
          });
        } catch {
          // ignore capture failures
        }
      },
    );
  };

  const pruneInternalTraceReplySubjects = (now: number = Date.now()): void => {
    for (const [subject, expiry] of internalTraceReplySubjects.entries()) {
      if (expiry <= now) {
        internalTraceReplySubjects.delete(subject);
      }
    }
    if (internalTraceReplySubjects.size <= MAX_NETWORK_TRACE_INTERNAL_SUBJECTS) {
      return;
    }
    const entries = [...internalTraceReplySubjects.entries()].sort(
      (a, b) => a[1] - b[1],
    );
    const extra =
      internalTraceReplySubjects.size - MAX_NETWORK_TRACE_INTERNAL_SUBJECTS;
    for (let i = 0; i < extra; i += 1) {
      internalTraceReplySubjects.delete(entries[i][0]);
    }
  };

  const rememberInternalTraceReplySubject = (subject: string): void => {
    const clean = `${subject ?? ""}`.trim();
    if (!clean) return;
    const now = Date.now();
    pruneInternalTraceReplySubjects(now);
    internalTraceReplySubjects.set(
      clean,
      now + NETWORK_TRACE_INTERNAL_SUBJECT_TTL_MS,
    );
  };

  const isInternalTraceReplySubject = (subject: string): boolean => {
    const clean = `${subject ?? ""}`.trim();
    if (!clean) return false;
    const now = Date.now();
    const expiry = internalTraceReplySubjects.get(clean);
    if (expiry == null) {
      return false;
    }
    if (expiry <= now) {
      internalTraceReplySubjects.delete(clean);
      return false;
    }
    return true;
  };

  const extractInternalTraceMethodName = (
    decodedPreview: unknown,
  ): string | undefined => {
    const text = `${decodedPreview ?? ""}`.trim();
    if (!text) return undefined;
    try {
      const row = JSON.parse(text) as { name?: unknown };
      const name = `${row?.name ?? ""}`.trim();
      return name || undefined;
    } catch {
      return undefined;
    }
  };

  const getReplySubjectFromHeaders = (headers: unknown): string | undefined => {
    if (!headers || typeof headers !== "object") {
      return undefined;
    }
    const row = headers as Record<string, unknown>;
    const reply = `${row["CN-Reply"] ?? ""}`.trim();
    return reply || undefined;
  };

  const removeBufferedEventsByChunkAndSubject = ({
    chunk_id,
    subject,
  }: {
    chunk_id?: string;
    subject: string;
  }): void => {
    const chunkId = `${chunk_id ?? ""}`.trim();
    if (!chunkId) return;
    for (let i = networkTraceEvents.length - 1; i >= 0; i -= 1) {
      const event = networkTraceEvents[i];
      if (
        `${event.chunk_id ?? ""}`.trim() === chunkId &&
        `${event.subject ?? ""}`.trim() === subject
      ) {
        networkTraceEvents.splice(i, 1);
      }
    }
  };

  const isProtocolEnabled = (protocol: BrowserNetworkTraceProtocol): boolean =>
    networkTraceConfig.protocols.includes(protocol);

  const toUrlOrigin = (value: unknown): string => {
    const text = `${value ?? ""}`.trim();
    if (!text) return "";
    try {
      return new URL(text, globalThis?.location?.href).origin;
    } catch {
      return "";
    }
  };

  const toByteLength = (value: unknown): number | undefined => {
    if (value == null) return undefined;
    if (typeof value === "string") {
      return value.length;
    }
    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    if (ArrayBuffer.isView(value)) {
      return value.byteLength;
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      return value.size;
    }
    return undefined;
  };

  const safeDecodedPreview = (value: unknown): string | undefined => {
    const text = safeStringifyForRuntimeLog(value).trim();
    if (!text) return undefined;
    return truncateRuntimeMessage(text).slice(
      0,
      Math.max(1, networkTraceConfig.max_preview_chars),
    );
  };

  const appendBufferedNetworkTraceEvent = (
    event: PendingNetworkTraceEvent,
  ): void => {
    if (!networkTraceConfig.enabled) {
      return;
    }
    if (!isProtocolEnabled(event.protocol)) {
      return;
    }
    const subject = `${event.subject ?? ""}`.trim();
    if (event.protocol === "conat" && !networkTraceConfig.include_internal) {
      if (isInternalTraceReplySubject(subject)) {
        return;
      }
      if (
        `${event.phase ?? ""}`.trim() === "recv_message" &&
        subject.includes(".browser-session")
      ) {
        const methodName = extractInternalTraceMethodName(event.decoded_preview);
        if (methodName != null && INTERNAL_TRACE_METHODS.has(methodName)) {
          const replySubject = getReplySubjectFromHeaders(event.headers);
          if (replySubject) {
            rememberInternalTraceReplySubject(replySubject);
          }
          removeBufferedEventsByChunkAndSubject({
            chunk_id: `${event.chunk_id ?? ""}`.trim() || undefined,
            subject,
          });
          return;
        }
      }
    }
    if (networkTraceConfig.subject_prefixes.length > 0) {
      const ok = networkTraceConfig.subject_prefixes.some((prefix) =>
        subject.startsWith(prefix),
      );
      if (!ok) {
        return;
      }
    }
    const address = `${event.address ?? ""}`.trim();
    if (
      networkTraceConfig.addresses.length > 0 &&
      !networkTraceConfig.addresses.includes(address)
    ) {
      return;
    }
    const decodedPreviewRaw = `${event.decoded_preview ?? ""}`.trim();
    const decoded_preview =
      networkTraceConfig.include_decoded && decodedPreviewRaw
        ? decodedPreviewRaw
        : undefined;
    networkTraceSeq += 1;
    networkTraceEvents.push({
      ...event,
      ...(decoded_preview ? { decoded_preview } : { decoded_preview: undefined }),
      seq: networkTraceSeq,
      ts: new Date().toISOString(),
      ...(typeof location !== "undefined" && location.href
        ? { url: `${location.href}` }
        : {}),
    });
    if (networkTraceEvents.length > networkTraceConfig.max_events) {
      const drop = networkTraceEvents.length - networkTraceConfig.max_events;
      networkTraceEvents.splice(0, drop);
      networkTraceDropped += drop;
    }
  };

  const appendConatNetworkTraceEvent = (event: ConatTraceEvent): void => {
    const direction = `${event.direction ?? ""}`.trim() as BrowserNetworkTraceDirection;
    const phase = `${event.phase ?? ""}`.trim() as BrowserNetworkTracePhase;
    appendBufferedNetworkTraceEvent({
      protocol: "conat",
      direction,
      phase,
      ...(event.client_id ? { client_id: `${event.client_id}` } : {}),
      ...(event.address ? { address: `${event.address}` } : {}),
      ...(event.subject ? { subject: `${event.subject}` } : {}),
      ...(event.chunk_id ? { chunk_id: `${event.chunk_id}` } : {}),
      ...(event.chunk_seq != null ? { chunk_seq: Number(event.chunk_seq) } : {}),
      ...(event.chunk_done != null ? { chunk_done: !!event.chunk_done } : {}),
      ...(event.chunk_bytes != null ? { chunk_bytes: Number(event.chunk_bytes) } : {}),
      ...(event.raw_bytes != null ? { raw_bytes: Number(event.raw_bytes) } : {}),
      ...(event.encoding != null ? { encoding: Number(event.encoding) } : {}),
      ...(event.headers ? { headers: event.headers as Record<string, unknown> } : {}),
      ...(event.decoded_preview ? { decoded_preview: `${event.decoded_preview}` } : {}),
      ...(event.decode_error ? { decode_error: `${event.decode_error}` } : {}),
      ...(event.message ? { message: `${event.message}` } : {}),
    });
  };

  const ensureConatTraceListener = (): void => {
    if (!networkTraceConfig.enabled || !isProtocolEnabled("conat")) {
      if (stopConatTraceListener) {
        stopConatTraceListener();
        stopConatTraceListener = undefined;
      }
      return;
    }
    if (stopConatTraceListener) {
      return;
    }
    stopConatTraceListener = onConatTrace((event) => {
      try {
        appendConatNetworkTraceEvent(event);
      } catch {
        // ignore trace buffering errors
      }
    });
  };

  const installNetworkTransportCapture = (): void => {
    const g = globalThis as any;
    if (g.__cocalc_browser_network_capture_installed) {
      return;
    }
    g.__cocalc_browser_network_capture_installed = true;

    const emitHttp = (event: PendingNetworkTraceEvent): void => {
      try {
        appendBufferedNetworkTraceEvent(event);
      } catch {
        // ignore capture failures
      }
    };
    const emitWs = (event: PendingNetworkTraceEvent): void => {
      try {
        appendBufferedNetworkTraceEvent(event);
      } catch {
        // ignore capture failures
      }
    };

    const originalFetch = typeof g.fetch === "function" ? g.fetch.bind(g) : undefined;
    if (originalFetch) {
      g.fetch = async (...args: any[]) => {
        const input = args[0];
        const init = args[1];
        const method = `${init?.method ?? input?.method ?? "GET"}`.toUpperCase();
        const target_url = `${input?.url ?? input ?? ""}`.trim();
        const started = Date.now();
        emitHttp({
          protocol: "http",
          direction: "send",
          phase: "http_request",
          address: toUrlOrigin(target_url),
          target_url,
          method,
          chunk_bytes: toByteLength(init?.body),
          ...(networkTraceConfig.include_decoded
            ? { decoded_preview: safeDecodedPreview(init?.body) }
            : {}),
        });
        try {
          const resp = await originalFetch(...args);
          const duration_ms = Date.now() - started;
          const contentLength = Number(resp?.headers?.get?.("content-length"));
          emitHttp({
            protocol: "http",
            direction: "recv",
            phase: "http_response",
            address: toUrlOrigin(resp?.url ?? target_url),
            target_url: `${resp?.url ?? target_url}`,
            method,
            status: Number(resp?.status),
            duration_ms,
            raw_bytes: Number.isFinite(contentLength) ? contentLength : undefined,
            message: `${resp?.status ?? ""} ${resp?.statusText ?? ""}`.trim(),
          });
          return resp;
        } catch (err) {
          emitHttp({
            protocol: "http",
            direction: "recv",
            phase: "http_error",
            address: toUrlOrigin(target_url),
            target_url,
            method,
            duration_ms: Date.now() - started,
            message: `${err}`,
          });
          throw err;
        }
      };
    }

    const OriginalXHR = g.XMLHttpRequest;
    if (typeof OriginalXHR === "function") {
      const open0 = OriginalXHR.prototype.open;
      const send0 = OriginalXHR.prototype.send;
      const setRequestHeader0 = OriginalXHR.prototype.setRequestHeader;
      OriginalXHR.prototype.open = function (...args: any[]) {
        (this as any).__cocalc_trace_method = `${args[0] ?? "GET"}`.toUpperCase();
        (this as any).__cocalc_trace_target_url = `${args[1] ?? ""}`.trim();
        (this as any).__cocalc_trace_headers = {};
        (this as any).__cocalc_trace_finished = false;
        return open0.apply(this, args);
      };
      OriginalXHR.prototype.setRequestHeader = function (name: string, value: string) {
        try {
          const h = ((this as any).__cocalc_trace_headers ??= {});
          h[`${name ?? ""}`] = `${value ?? ""}`;
        } catch {}
        return setRequestHeader0.apply(this, [name, value]);
      };
      OriginalXHR.prototype.send = function (...args: any[]) {
        const method = `${(this as any).__cocalc_trace_method ?? "GET"}`;
        const target_url = `${(this as any).__cocalc_trace_target_url ?? ""}`.trim();
        const started = Date.now();
        emitHttp({
          protocol: "http",
          direction: "send",
          phase: "http_request",
          address: toUrlOrigin(target_url),
          target_url,
          method,
          chunk_bytes: toByteLength(args[0]),
          headers: (this as any).__cocalc_trace_headers,
          ...(networkTraceConfig.include_decoded
            ? { decoded_preview: safeDecodedPreview(args[0]) }
            : {}),
        });
        const emitDone = (phase: BrowserNetworkTracePhase, message?: string) => {
          if ((this as any).__cocalc_trace_finished) {
            return;
          }
          (this as any).__cocalc_trace_finished = true;
          const contentLength = Number(this.getResponseHeader?.("content-length"));
          emitHttp({
            protocol: "http",
            direction: "recv",
            phase,
            address: toUrlOrigin(this.responseURL || target_url),
            target_url: `${this.responseURL || target_url}`,
            method,
            status: Number(this.status),
            duration_ms: Date.now() - started,
            raw_bytes: Number.isFinite(contentLength) ? contentLength : undefined,
            message,
          });
        };
        this.addEventListener(
          "loadend",
          () => emitDone("http_response", `${this.status ?? ""}`.trim()),
          { once: true },
        );
        this.addEventListener("error", () => emitDone("http_error", "xhr error"), {
          once: true,
        });
        this.addEventListener(
          "timeout",
          () => emitDone("http_error", "xhr timeout"),
          {
            once: true,
          },
        );
        this.addEventListener("abort", () => emitDone("http_error", "xhr abort"), {
          once: true,
        });
        return send0.apply(this, args);
      };
    }

    const OriginalWebSocket = g.WebSocket;
    if (typeof OriginalWebSocket === "function") {
      const PatchedWebSocket = function (this: any, url: any, protocols?: any) {
        const ws =
          protocols === undefined
            ? new OriginalWebSocket(url)
            : new OriginalWebSocket(url, protocols);
        const target_url = `${url ?? ""}`.trim();
        const address = toUrlOrigin(target_url);
        ws.addEventListener("open", () => {
          emitWs({
            protocol: "ws",
            direction: "recv",
            phase: "ws_open",
            address,
            target_url,
          });
        });
        ws.addEventListener("message", (ev: MessageEvent) => {
          emitWs({
            protocol: "ws",
            direction: "recv",
            phase: "ws_message",
            address,
            target_url,
            chunk_bytes: toByteLength(ev.data),
            ...(networkTraceConfig.include_decoded
              ? { decoded_preview: safeDecodedPreview(ev.data) }
              : {}),
          });
        });
        ws.addEventListener("close", (ev: CloseEvent) => {
          emitWs({
            protocol: "ws",
            direction: "recv",
            phase: "ws_close",
            address,
            target_url,
            status: Number(ev.code),
            message: `${ev.reason ?? ""}`.trim() || `ws close code=${ev.code}`,
          });
        });
        ws.addEventListener("error", () => {
          emitWs({
            protocol: "ws",
            direction: "recv",
            phase: "ws_error",
            address,
            target_url,
            message: "ws error",
          });
        });
        const send0 = ws.send.bind(ws);
        ws.send = (data: any) => {
          emitWs({
            protocol: "ws",
            direction: "send",
            phase: "ws_send",
            address,
            target_url,
            chunk_bytes: toByteLength(data),
            ...(networkTraceConfig.include_decoded
              ? { decoded_preview: safeDecodedPreview(data) }
              : {}),
          });
          return send0(data);
        };
        return ws;
      } as any;
      PatchedWebSocket.prototype = OriginalWebSocket.prototype;
      Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
      g.WebSocket = PatchedWebSocket;
    }
  };

  installRuntimeCapture();
  installNetworkTransportCapture();

  const configureNetworkTrace = (
    opts: ConfigureNetworkTraceOpts,
  ): ConfigureNetworkTraceResult => {
    if (opts != null && typeof opts === "object") {
      if (opts.enabled != null) {
        networkTraceConfig.enabled = !!opts.enabled;
      }
      if (opts.include_decoded != null) {
        networkTraceConfig.include_decoded = !!opts.include_decoded;
      }
      if (opts.include_internal != null) {
        networkTraceConfig.include_internal = !!opts.include_internal;
      }
      if (Array.isArray(opts.protocols)) {
        const next = opts.protocols
          .map((x) => `${x ?? ""}`.trim().toLowerCase())
          .filter(
            (x): x is BrowserNetworkTraceProtocol =>
              x === "conat" || x === "http" || x === "ws",
          );
        networkTraceConfig.protocols =
          next.length > 0 ? [...new Set(next)] : [...ALL_NETWORK_TRACE_PROTOCOLS];
      }
      if (opts.max_events != null && Number.isFinite(Number(opts.max_events))) {
        networkTraceConfig.max_events = Math.max(
          100,
          Math.min(MAX_NETWORK_TRACE_EVENTS, Math.floor(Number(opts.max_events))),
        );
        if (networkTraceEvents.length > networkTraceConfig.max_events) {
          const drop = networkTraceEvents.length - networkTraceConfig.max_events;
          networkTraceEvents.splice(0, drop);
          networkTraceDropped += drop;
        }
      }
      if (
        opts.max_preview_chars != null &&
        Number.isFinite(Number(opts.max_preview_chars))
      ) {
        networkTraceConfig.max_preview_chars = Math.max(
          32,
          Math.min(20_000, Math.floor(Number(opts.max_preview_chars))),
        );
      }
      if (Array.isArray(opts.subject_prefixes)) {
        networkTraceConfig.subject_prefixes = opts.subject_prefixes
          .map((x) => `${x ?? ""}`.trim())
          .filter((x) => x.length > 0);
      }
      if (Array.isArray(opts.addresses)) {
        networkTraceConfig.addresses = opts.addresses
          .map((x) => `${x ?? ""}`.trim())
          .filter((x) => x.length > 0);
      }
    }
    ensureConatTraceListener();
    return {
      enabled: networkTraceConfig.enabled,
      include_decoded: networkTraceConfig.include_decoded,
      include_internal: networkTraceConfig.include_internal,
      protocols: [...networkTraceConfig.protocols],
      max_events: networkTraceConfig.max_events,
      max_preview_chars: networkTraceConfig.max_preview_chars,
      subject_prefixes: [...networkTraceConfig.subject_prefixes],
      addresses: [...networkTraceConfig.addresses],
      buffered: networkTraceEvents.length,
      dropped: networkTraceDropped,
      next_seq: networkTraceSeq,
    };
  };

  const listNetworkTrace = (opts: ListNetworkTraceOpts): ListNetworkTraceResult => {
    const after_seq = Number(opts?.after_seq ?? 0);
    const limitRaw = Number(opts?.limit ?? 200);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(MAX_NETWORK_TRACE_EVENTS, Math.floor(limitRaw)))
      : 200;
    const protocols =
      Array.isArray(opts?.protocols) && opts?.protocols.length > 0
        ? new Set(
            opts.protocols
              .map((x) => `${x ?? ""}`.trim().toLowerCase())
              .filter((x) => x.length > 0),
          )
        : opts?.protocol
          ? new Set([`${opts.protocol ?? ""}`.trim().toLowerCase()])
          : undefined;
    const direction = `${opts?.direction ?? ""}`.trim().toLowerCase();
    const phases =
      Array.isArray(opts?.phases) && opts?.phases.length > 0
        ? new Set(opts.phases.map((x) => `${x ?? ""}`.trim()))
        : undefined;
    const subjectPrefix = `${opts?.subject_prefix ?? ""}`.trim();
    const address = `${opts?.address ?? ""}`.trim();
    const includeDecoded =
      opts?.include_decoded == null
        ? networkTraceConfig.include_decoded
        : !!opts.include_decoded;
    const filtered = networkTraceEvents.filter((event) => {
      if (Number.isFinite(after_seq) && event.seq <= after_seq) {
        return false;
      }
      if (protocols && !protocols.has(`${event.protocol ?? ""}`)) {
        return false;
      }
      if (direction && event.direction !== direction) {
        return false;
      }
      if (phases && !phases.has(`${event.phase ?? ""}`)) {
        return false;
      }
      if (subjectPrefix && !`${event.subject ?? ""}`.startsWith(subjectPrefix)) {
        return false;
      }
      if (address && `${event.address ?? ""}` !== address) {
        return false;
      }
      return true;
    });
    const events = filtered
      .slice(Math.max(0, filtered.length - limit))
      .map((event) =>
        includeDecoded
          ? event
          : {
              ...event,
              decoded_preview: undefined,
            },
      );
    return {
      events,
      next_seq: networkTraceSeq,
      dropped: networkTraceDropped,
      total_buffered: networkTraceEvents.length,
    };
  };

  const clearNetworkTrace = (): ClearNetworkTraceResult => {
    const cleared = networkTraceEvents.length;
    networkTraceEvents.length = 0;
    networkTraceDropped = 0;
    internalTraceReplySubjects.clear();
    return { ok: true, cleared, next_seq: networkTraceSeq };
  };

  const listRuntimeEvents = (opts: ListRuntimeEventsOpts): ListRuntimeEventsResult => {
    const after_seq = Number(opts?.after_seq ?? 0);
    const limitRaw = Number(opts?.limit ?? 200);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(5_000, Math.floor(limitRaw)))
      : 200;
    const kinds = new Set<BrowserRuntimeEventKind>(
      Array.isArray(opts?.kinds)
        ? opts.kinds
            .map((x) => `${x ?? ""}`.trim())
            .filter(
              (x): x is BrowserRuntimeEventKind =>
                x === "console" ||
                x === "uncaught_error" ||
                x === "unhandled_rejection",
            )
        : [],
    );
    const levels = new Set<BrowserRuntimeEventLevel>(
      Array.isArray(opts?.levels)
        ? opts.levels
            .map((x) => `${x ?? ""}`.trim())
            .filter(
              (x): x is BrowserRuntimeEventLevel =>
                x === "trace" ||
                x === "debug" ||
                x === "log" ||
                x === "info" ||
                x === "warn" ||
                x === "error",
            )
        : [],
    );
    const filtered = runtimeEvents.filter((event) => {
      if (Number.isFinite(after_seq) && event.seq <= after_seq) {
        return false;
      }
      if (kinds.size > 0 && !kinds.has(event.kind)) {
        return false;
      }
      if (levels.size > 0 && !levels.has(event.level)) {
        return false;
      }
      return true;
    });
    const events = filtered.slice(Math.max(0, filtered.length - limit));
    return {
      events,
      next_seq: runtimeEventSeq,
      dropped: runtimeEventsDropped,
      total_buffered: runtimeEvents.length,
    };
  };

  const reset = (): void => {
    runtimeEvents.length = 0;
    runtimeEventSeq = 0;
    runtimeEventsDropped = 0;
    networkTraceEvents.length = 0;
    networkTraceSeq = 0;
    networkTraceDropped = 0;
    internalTraceReplySubjects.clear();
  };

  const onStart = (): void => {
    ensureConatTraceListener();
  };

  const stop = (): void => {
    if (stopConatTraceListener) {
      stopConatTraceListener();
      stopConatTraceListener = undefined;
    }
  };

  return {
    configureNetworkTrace,
    listNetworkTrace,
    clearNetworkTrace,
    listRuntimeEvents,
    reset,
    onStart,
    stop,
  };
}
