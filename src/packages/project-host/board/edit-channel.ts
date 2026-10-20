/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
One frame's edit channel on the project host (A2b design v9, sections 1b, 2
and 4, steps 0 to 4): what happens to an `edit` message before it is admitted
to the board's commit queue. Everything here is synchronous, so the edit's id
is recorded as pending in the same turn of the event loop that received it,
before anything is awaited (astra's CORR-A2B-1).

In order, for each message:
0. the channel's own id window: a duplicate of the edit in flight, or of one
   of the last 100 answered, is ignored (no answer);
1. its encoded size: at most 1 MiB;
2. one edit in flight per channel;
3. the channel's own preview bucket, taken BEFORE preview (a count of 40,
   refilled at 4 a second; and 64 MiB of work, refilled at 6.4 MiB a second,
   charged each preview's workBytes afterwards, refused previews included);
4. editState.preview, which draws on the host's one shared preview budget.
   "Throttled" is "not computed": busy, send again.
5. the work its commit would take, counted from the changes preview made
   and the records as they are (edit-cost.ts, G2): over the caps, it is
   refused "too-large" (what: "work") before it is admitted.

Every answer is recorded in the channel's window (and editState's) before it
is sent, and an id leaves `pending` only as it enters `answered`.

The frame is untrusted: nothing in a message chooses the board, and its
fields are only ever read, never used as keys of host objects.
*/

import type {
  EditState,
  Key,
  Previewed,
} from "@sagemathinc/sagebrush-board/submission";
import { TokenBucket } from "./admission";
import {
  type EditWork,
  type EditWorkLimits,
  editWork,
  editWorkRefusal,
  hostEditWorkLimits,
} from "./edit-cost";
import { BOARD_STRING_COLS } from "@cocalc/util/board/names";

const STRING_COLS: ReadonlySet<string> = new Set(BOARD_STRING_COLS);

export const EDIT_CHANNEL_LIMITS = {
  messageBytes: 1024 * 1024,
  answeredIds: 100,
  previewBurst: 40,
  previewPerSecond: 4,
  previewWorkBurst: 64 * 1024 * 1024,
  previewWorkPerSecond: 6.4 * 1024 * 1024,
  // A busy refusal while an edit is in flight.
  inFlightRetryMs: 250,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The admission client id: one fixed, validated, server-derived format (the
// transport sets it from the authenticated caller), never frame data.
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function editClientId(accountId: string, connectionId: string): string {
  if (!UUID.test(accountId)) throw Error("invalid account id");
  if (!CONNECTION_ID.test(connectionId)) throw Error("invalid connection id");
  return `${accountId.toLowerCase()}:${connectionId}`;
}

export type Refused = {
  sagebrush: "refused";
  version: 1;
  id: string;
  message: string;
  reason?: string;
  what?: string;
  limit?: number;
  size?: number;
  retryAfter?: number;
};

// What intake decided about one message.
export type Intake =
  // Nothing to answer: a duplicate, an id already answered, or not an edit.
  | { kind: "ignore" }
  // Answered at once (recorded, and sent).
  | { kind: "answered"; answer: Refused }
  // Admitted to the board's commit queue: pending until answered.
  | {
      kind: "admit";
      id: string;
      message: unknown;
      editBytes: number;
      // What committing it will take (G2's counters).
      work: EditWork;
    };

type Clock = () => number;

const monotonic: Clock = () => performance.now();

export type EditChannelLimits = typeof EDIT_CHANNEL_LIMITS;

export class EditChannel {
  readonly clientId: string;
  private readonly limits: EditChannelLimits;
  readonly editState: EditState;
  private readonly currentRecord: (
    key: Key,
  ) => { [field: string]: unknown } | undefined;
  // The work caps, if fixed (else this host's, as calibrated now).
  private readonly workLimits?: EditWorkLimits;
  private readonly send: (message: object) => void;
  private readonly now: Clock;
  private readonly count: TokenBucket;
  private readonly work: TokenBucket;
  // The id of the edit in flight.
  private pendingId: string | undefined;
  // The last answered ids, oldest first, and a set of them.
  private readonly answeredOrder: string[] = [];
  private readonly answeredSet = new Set<string>();

  constructor({
    clientId,
    editState,
    currentRecord,
    send,
    now = monotonic,
    limits = EDIT_CHANNEL_LIMITS,
    // This host's calibrated limits (edit-cost.ts) unless given.
    workLimits,
  }: {
    clientId: string;
    editState: EditState;
    // A record of the board's live document as it is now (the syncdb's
    // get_one), for the work an edit's commit takes.
    currentRecord: (key: Key) => { [field: string]: unknown } | undefined;
    send: (message: object) => void;
    now?: Clock;
    limits?: EditChannelLimits;
    workLimits?: EditWorkLimits;
  }) {
    this.clientId = clientId;
    this.limits = limits;
    this.editState = editState;
    this.currentRecord = currentRecord;
    this.workLimits = workLimits;
    this.send = send;
    this.now = now;
    const t = now();
    this.count = new TokenBucket(
      limits.previewBurst,
      limits.previewPerSecond,
      t,
    );
    this.work = new TokenBucket(
      limits.previewWorkBurst,
      limits.previewWorkPerSecond,
      t,
    );
  }

  get pending(): string | undefined {
    return this.pendingId;
  }

  hasAnswered(id: string): boolean {
    return this.answeredSet.has(id);
  }

  // Steps 0 to 4, synchronously.
  intake(message: unknown): Intake {
    const id = editId(message);
    if (id === undefined) return { kind: "ignore" };
    // 0. The channel's own window, before anything else.
    if (id === this.pendingId || this.answeredSet.has(id)) {
      return { kind: "ignore" };
    }
    // 1. Size, before anything is parsed further. The transport bounds what
    // reaches here, so measuring it is bounded too.
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(message));
    } catch {
      return this.refuse(id, {
        message: "not an edit message",
        reason: "invalid",
      });
    }
    if (bytes > this.limits.messageBytes) {
      return this.refuse(id, {
        message: "this change is too large to save here",
        reason: "too-large",
        what: "edit",
        limit: this.limits.messageBytes,
        size: bytes,
      });
    }
    // 2. One in flight.
    if (this.pendingId !== undefined) {
      return this.refuse(id, {
        message: "an earlier change is still being saved",
        reason: "busy",
        retryAfter: this.limits.inFlightRetryMs,
      });
    }
    // 3. The channel's own preview bucket, taken before preview.
    const t = this.now();
    const wait = Math.max(this.count.wait(1, t), this.work.wait(0, t));
    if (wait > 0) {
      return this.refuse(id, {
        message: "too many changes at once; sending again shortly",
        reason: "busy",
        retryAfter: wait,
      });
    }
    this.count.take(1, t);
    // 4. Preview, on the host's shared budget. Its work is charged to this
    // channel whatever it decided.
    let r: Previewed;
    try {
      r = this.editState.preview(message);
    } catch (err) {
      return this.refuse(id, {
        message: "this change could not be checked",
        reason: "invalid",
      });
    }
    this.work.take(Math.max(0, r.workBytes ?? 0), t);
    if (!r.ok) {
      if (r.ignore) {
        // editState already answered it.
        this.remember(id);
        return { kind: "ignore" };
      }
      if (r.previewThrottled) {
        return this.refuse(id, {
          message: "the server is busy; sending again shortly",
          reason: "busy",
          retryAfter: r.retryAfter ?? 1000,
        });
      }
      return this.refuse(id, {
        message: r.message,
        reason: r.reason,
        what: r.what,
        limit: r.limit,
        size: r.size,
        retryAfter: r.retryAfter,
      });
    }
    // 5. The work its commit would take, before it is admitted.
    const work = editWork(r.changes, this.currentRecord, STRING_COLS);
    const tooMuch = editWorkRefusal(
      work,
      this.workLimits ?? hostEditWorkLimits(),
    );
    if (tooMuch) return this.refuse(id, tooMuch);
    this.pendingId = id;
    return { kind: "admit", id, message, editBytes: r.editBytes, work };
  }

  // Answer an edit: recorded first, then sent. The pending edit leaves
  // pending only here.
  answer(id: string, answer: object): void {
    if (this.answeredSet.has(id)) {
      throw Error(`edit ${id} was already answered`);
    }
    this.remember(id);
    if (this.pendingId === id) this.pendingId = undefined;
    this.send(answer);
  }

  // A refusal for an edit that was never admitted.
  private refuse(
    id: string,
    r: Omit<Refused, "sagebrush" | "version" | "id">,
  ): Intake {
    const answer: Refused = {
      sagebrush: "refused",
      version: 1,
      id,
      message: `${r.message ?? "refused"}`.slice(0, 500),
    };
    for (const k of [
      "reason",
      "what",
      "limit",
      "size",
      "retryAfter",
    ] as const) {
      if (r[k] !== undefined) (answer as any)[k] = r[k];
    }
    this.answer(id, answer);
    return { kind: "answered", answer };
  }

  private remember(id: string): void {
    if (this.answeredSet.has(id)) return;
    this.answeredSet.add(id);
    this.answeredOrder.push(id);
    // editState remembers the host's own answers too, so neither window
    // can let an id be merged twice.
    try {
      this.editState.answered(id);
    } catch {}
    while (this.answeredOrder.length > this.limits.answeredIds) {
      this.answeredSet.delete(this.answeredOrder.shift()!);
    }
  }
}

// The id of an edit message, or undefined if it isn't one.
function editId(message: unknown): string | undefined {
  if (
    message == null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return;
  }
  const m = message as { sagebrush?: unknown; version?: unknown; id?: unknown };
  if (m.sagebrush !== "edit" || m.version !== 1) return;
  if (typeof m.id !== "string" || !UUID.test(m.id)) return;
  return m.id;
}
