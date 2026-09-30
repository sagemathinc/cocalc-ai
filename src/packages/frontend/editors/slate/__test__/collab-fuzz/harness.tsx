/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Headless multi-client harness for realtime collaborative Markdown editing.

Each simulated client runs the real integration code: a real patchflow Session,
a fake SyncString exposing the surface the frame editor uses, fake frame-editor
actions, and a mounted EditableMarkdown whose Slate editor is driven directly.
Clients exchange patches over a seeded network that delays and reorders
messages. See src/.agents/harden-realtime-collaborative-editing-plan-2026-09-30.md.
*/

import { EventEmitter } from "events";
import { act, render } from "@testing-library/react";
import {
  Session,
  StringDocument,
  type PatchEnvelope,
  type PatchStore,
} from "patchflow";
import { Editor, Transforms, Text, type Descendant } from "slate";
import { EditableMarkdown } from "../../editable-markdown";
import { markdown_to_slate } from "../../markdown-to-slate/parse";
import { slate_to_markdown } from "../../slate-to-markdown";
import { preserveSourceForTrailingBlankWhitespaceOnly } from "../../trailing-whitespace";
import { ReactEditor } from "../../slate-react";

export type Rng = () => number;

// Small deterministic PRNG so every failure is replayable from its seed.
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T,>(rng: Rng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)];

const codec = {
  fromString: (s: string) => new StringDocument(s),
  toString: (d: any) => d.toString(),
  applyPatch: (d: any, p: unknown) => d.applyPatch(p),
  applyPatchBatch: (d: any, ps: unknown[]) => d.applyPatchBatch(ps),
  makePatch: (a: any, b: any) => a.makePatch(b),
};

interface InFlight {
  to: number;
  env: PatchEnvelope;
  deliverAt: number;
}

export class SimNetwork {
  private queue: InFlight[] = [];
  private receivers = new Map<number, (env: PatchEnvelope) => void>();
  public log: { from: number; env: PatchEnvelope }[] = [];

  constructor(
    private rng: Rng,
    private now: () => number,
    private maxDelayMs: number,
  ) {}

  register(id: number, onEnvelope: (env: PatchEnvelope) => void): void {
    this.receivers.set(id, onEnvelope);
  }

  send(from: number, env: PatchEnvelope): void {
    this.log.push({ from, env });
    for (const to of this.receivers.keys()) {
      if (to === from) continue;
      this.queue.push({
        to,
        env,
        deliverAt: this.now() + Math.floor(this.rng() * this.maxDelayMs),
      });
    }
  }

  pending(): number {
    return this.queue.length;
  }

  // Deliver messages that are due, in random order (reordering is allowed;
  // patchflow must tolerate it).
  deliverDue(all = false): number {
    const now = this.now();
    const due = this.queue.filter((m) => all || m.deliverAt <= now);
    this.queue = this.queue.filter((m) => !due.includes(m));
    for (let i = due.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [due[i], due[j]] = [due[j], due[i]];
    }
    for (const m of due) {
      if (process.env.FUZZ_SLATE_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`### deliver to c${m.to} (${m.env.time})`);
      }
      this.receivers.get(m.to)?.(m.env);
    }
    return due.length;
  }
}

class SimPatchStore implements PatchStore {
  private listeners: ((env: PatchEnvelope) => void)[] = [];
  constructor(
    private id: number,
    private net: SimNetwork,
    private initial: PatchEnvelope[],
  ) {
    net.register(id, (env) => {
      for (const fn of this.listeners) fn(env);
    });
  }
  async loadInitial() {
    return { patches: this.initial.slice() };
  }
  append(env: PatchEnvelope): void {
    this.net.send(this.id, env);
  }
  subscribe(fn: (env: PatchEnvelope) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  }
}

// The subset of SyncString used by the Markdown frame editor integration.
class FakeSyncString extends EventEmitter {
  constructor(public session: Session) {
    super();
    session.on("patch", () => {
      // The real SyncString emits "change" for merged remote patches.
      this.emit("change");
    });
  }
  to_str(): string {
    return this.session.getDocument().toString();
  }
  get_state(): string {
    return "ready";
  }
  exit_undo_mode(): void {}
}

export interface ClientOptions {
  id: number;
  // Emulates a CodeMirror frame on the same document (source edits).
  hasSourceFrame: boolean;
}

export class SimClient {
  public session!: Session;
  public syncstring!: FakeSyncString;
  public editor?: any;
  public actions: any;
  // Every local commit, for classifying oracle violations.
  public commits: { before: string; after: string; source?: string }[] = [];
  public onCommit?: (commit: {
    before: string;
    after: string;
    source?: string;
  }) => void;
  private unmount?: () => void;

  constructor(
    public opts: ClientOptions,
    private net: SimNetwork,
    private clock: () => number,
    private initial: PatchEnvelope[],
  ) {}

  async start(initialValue: string): Promise<void> {
    const store = new SimPatchStore(this.opts.id, this.net, this.initial);
    this.session = new Session({
      codec,
      patchStore: store,
      clock: this.clock,
      userId: this.opts.id + 1,
      clientId: `client${this.opts.id}`,
    });
    await this.session.init();
    this.syncstring = new FakeSyncString(this.session);
    const syncstring = this.syncstring;
    const session = this.session;
    this.actions = {
      _syncstring: syncstring,
      registerSlateEditor: (_id: string, ed: any) => {
        this.editor = ed;
      },
      // Mirrors markdown-editor actions.set_value + actions-base.set_syncstring.
      set_value: (value: string, _undo?: boolean, source?: string) => {
        if (source === "slate") {
          value = preserveSourceForTrailingBlankWhitespaceOnly({
            source: syncstring.to_str(),
            normalized: value,
          });
        }
        const before = syncstring.to_str();
        if (before === value) return;
        session.commit(new StringDocument(value));
        this.commits.push({ before, after: value, source });
        this.onCommit?.({ before, after: value, source });
        syncstring.emit("change", { local: true, source });
      },
      syncstring_commit: () => {},
      ensure_syncstring_is_saved: () => {},
    };
    const { unmount } = render(
      <EditableMarkdown
        value={initialValue}
        actions={this.actions}
        id={`frame${this.opts.id}`}
        is_current
        saveDebounceMs={50}
        enableUpload={false}
        minimal
        hidePath
        disableWindowing
        noVfill
        showEditBar={false}
        height="auto"
      />,
    );
    this.unmount = unmount;
  }

  stop(): void {
    this.unmount?.();
    this.session.close();
  }

  doc(): string {
    return this.syncstring.to_str();
  }

  // What the editor actually displays, serialized from its tree.
  shown(): string {
    return slate_to_markdown(this.editor.children as Descendant[], {});
  }
}

export const TOKEN_RE = /tk[a-z]\d+q/g;

export function tokensIn(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

// Canonical markdown for comparing what an editor shows with a document.
export function canonical(markdown: string): string {
  return slate_to_markdown(markdown_to_slate(markdown, false, {}), {});
}

export function textEntries(editor: Editor): [Text, number[]][] {
  return Array.from(
    Editor.nodes(editor, { at: [], match: (n) => Text.isText(n) }),
  ) as any;
}

export function focus(client: SimClient): void {
  try {
    ReactEditor.focus(client.editor);
  } catch {
    // Focus is best effort in jsdom.
  }
}

export function blur(client: SimClient): void {
  try {
    ReactEditor.blur(client.editor);
  } catch {
    // ignore
  }
}

export async function step(fn: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

export { Transforms, markdown_to_slate };
