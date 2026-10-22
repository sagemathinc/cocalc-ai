/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A small record of what moved the chat log: the reader's input, scroll
// positions, rows changing height, and every scroll the log (or its list)
// asks for. When the log jumps, the entries just before it name the cause.
// Cheap and always on; read it in the browser console with
//   copy(JSON.stringify(cocalcChatScrollJournal()))

export type ScrollJournalEntry = {
  t: number;
  kind: string;
  [key: string]: unknown;
};

const MAX_ENTRIES = 3000;
const entries: ScrollJournalEntry[] = [];

const now = () =>
  Math.round(
    typeof performance !== "undefined" ? performance.now() : Date.now(),
  );

export function journalScroll(
  kind: string,
  data: Record<string, unknown> = {},
): void {
  entries.push({ t: now(), kind, ...data });
  if (entries.length > MAX_ENTRIES)
    entries.splice(0, entries.length - MAX_ENTRIES);
}

export function scrollJournal(): ScrollJournalEntry[] {
  return entries.slice();
}

export function clearScrollJournal(): void {
  entries.length = 0;
}

/**
 * Record every scroll position written to this element (by the list or by
 * the log), with how: scrollTop, scrollTo or scrollBy. Returns an undo.
 */
export function journalScrollWrites(element: HTMLElement): () => void {
  const proto = Object.getPrototypeOf(element);
  let descriptor: PropertyDescriptor | undefined;
  for (let p = proto; p && !descriptor; p = Object.getPrototypeOf(p))
    descriptor = Object.getOwnPropertyDescriptor(p, "scrollTop");
  const scrollTo = element.scrollTo;
  const scrollBy = element.scrollBy;
  if (descriptor?.get && descriptor.set) {
    const { get, set } = descriptor;
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get() {
        return get.call(this);
      },
      set(value: number) {
        journalScroll("write", {
          via: "scrollTop",
          from: Math.round(get.call(this)),
          to: Math.round(value),
        });
        set.call(this, value);
      },
    });
  }
  if (typeof scrollTo === "function") {
    element.scrollTo = function (this: HTMLElement, ...args: any[]) {
      const top =
        typeof args[0] === "object" ? args[0]?.top : (args[1] as number);
      journalScroll("write", {
        via: "scrollTo",
        from: Math.round(element.scrollTop),
        to: top == null ? undefined : Math.round(top),
      });
      return (scrollTo as any).apply(this, args);
    } as typeof element.scrollTo;
  }
  if (typeof scrollBy === "function") {
    element.scrollBy = function (this: HTMLElement, ...args: any[]) {
      const top =
        typeof args[0] === "object" ? args[0]?.top : (args[1] as number);
      journalScroll("write", {
        via: "scrollBy",
        from: Math.round(element.scrollTop),
        by: top == null ? undefined : Math.round(top),
      });
      return (scrollBy as any).apply(this, args);
    } as typeof element.scrollBy;
  }
  return () => {
    delete (element as any).scrollTop;
    element.scrollTo = scrollTo;
    element.scrollBy = scrollBy;
  };
}

if (typeof window !== "undefined") {
  (window as any).cocalcChatScrollJournal = scrollJournal;
  (window as any).cocalcChatScrollJournalClear = clearScrollJournal;
}
