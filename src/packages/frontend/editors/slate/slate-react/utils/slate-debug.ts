import { DOMSelection } from "./dom";

type SlateDebugEvent = {
  ts: number;
  seq: number;
  type: string;
  data?: Record<string, unknown>;
};

type SlateDebug = {
  events: SlateDebugEvent[];
  max: number;
  push: (type: string, data?: Record<string, unknown>) => SlateDebugEvent;
  dump: () => SlateDebugEvent[];
  clear: () => void;
  snapshot: () => {
    last?: SlateDebugEvent;
    size: number;
    max: number;
  };
};

type SlateDebugBuffer = {
  events: SlateDebugEvent[];
  max: number;
  cursor: number;
  wrapped: boolean;
  seq: number;
};

declare global {
  interface Window {
    __slateDebug?: SlateDebug;
  }
}

const DEFAULT_MAX_EVENTS = 200;

function createBuffer(max: number): SlateDebugBuffer {
  return { events: [], max, cursor: 0, wrapped: false, seq: 0 };
}

function bufferPush(buffer: SlateDebugBuffer, event: SlateDebugEvent): void {
  if (buffer.events.length < buffer.max) {
    buffer.events.push(event);
  } else {
    buffer.events[buffer.cursor] = event;
    buffer.cursor = (buffer.cursor + 1) % buffer.max;
    buffer.wrapped = true;
  }
}

function bufferDump(buffer: SlateDebugBuffer): SlateDebugEvent[] {
  if (!buffer.wrapped) {
    return buffer.events.slice();
  }
  return buffer.events
    .slice(buffer.cursor)
    .concat(buffer.events.slice(0, buffer.cursor));
}

function bufferLast(buffer: SlateDebugBuffer): SlateDebugEvent | undefined {
  if (buffer.events.length === 0) return undefined;
  if (!buffer.wrapped) {
    return buffer.events[buffer.events.length - 1];
  }
  const index = (buffer.cursor - 1 + buffer.max) % buffer.max;
  return buffer.events[index];
}

export function getSlateDebug(): SlateDebug | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (window.__slateDebug) {
    return window.__slateDebug;
  }
  const buffer = createBuffer(DEFAULT_MAX_EVENTS);
  const debug: SlateDebug = {
    events: buffer.events,
    max: buffer.max,
    push: (type, data) => {
      const event: SlateDebugEvent = {
        ts: Date.now(),
        seq: (buffer.seq += 1),
        type,
        data,
      };
      bufferPush(buffer, event);
      return event;
    },
    dump: () => bufferDump(buffer),
    clear: () => {
      buffer.events.length = 0;
      buffer.cursor = 0;
      buffer.wrapped = false;
    },
    snapshot: () => ({
      last: bufferLast(buffer),
      size: buffer.events.length,
      max: buffer.max,
    }),
  };
  window.__slateDebug = debug;
  return debug;
}

export function logSlateDebug(
  type: string,
  data?: Record<string, unknown>,
): void {
  const debug = getSlateDebug();
  if (!debug) return;
  debug.push(type, data);
}

export function describeDomSelection(domSelection: DOMSelection) {
  return {
    type: domSelection.type,
    isCollapsed: domSelection.isCollapsed,
    anchorNode: describeDomNode(domSelection.anchorNode),
    anchorOffset: domSelection.anchorOffset,
    focusNode: describeDomNode(domSelection.focusNode),
    focusOffset: domSelection.focusOffset,
  };
}

function describeDomNode(node: Node | null): string | null {
  if (!node) return null;
  if (node.nodeType === 3) {
    const text = node.textContent ?? "";
    const preview = text.length > 30 ? `${text.slice(0, 30)}...` : text;
    return `#text("${preview}")`;
  }
  if (node.nodeType === 1) {
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const attrs: string[] = [];
    const slateNode = el.getAttribute("data-slate-node");
    const slateLeaf = el.getAttribute("data-slate-leaf");
    const slateZero = el.getAttribute("data-slate-zero-width");
    if (slateNode) attrs.push(`data-slate-node=${slateNode}`);
    if (slateLeaf != null) attrs.push("data-slate-leaf");
    if (slateZero) attrs.push(`data-slate-zero-width=${slateZero}`);
    return attrs.length ? `${tag}[${attrs.join(" ")}]` : tag;
  }
  return `nodeType=${node.nodeType}`;
}
