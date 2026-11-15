/*
028 B-3a (AS-B3-ORDER-1, SA 3381): one client's writes commit in the order it
issued them, also when the write budget refuses some of them.

The client numbers every write when it is ISSUED (wseq, before the first
send) and sends with it wfloor: the smallest wseq it has not resolved yet
(answered, failed or given up).  A refused write is resent with the same
wseq, and only after every write with a smaller wseq is resolved.

The server keeps this state per CONNECTION (one per persist socket, created
and dropped with it in server.ts), never under a client-chosen key: another
connection can't touch it.  For a write with (wseq, wfloor):
- wseq below the floor (the highest wfloor seen; it never goes down): the
  client already resolved that write, so this copy is stale (a late or
  duplicate delivery) and is rejected, never applied;
- an earlier write not yet SEEN here (a gap between the floor and this
  wseq: it is still in transit, e.g. across a reconnect, or was lost until
  the client resolves it): refused (rate_limited) and recorded -- so the
  order does not rest on the transport delivering in order;
- an earlier write of this connection still refused (not yet resent and
  admitted): refused too (rate_limited), and recorded;
- otherwise it goes on to the budget; refused there -> recorded; admitted ->
  removed.
Entries below the floor are dropped (the client resolved them).  The state
is bounded: at most MAX_REFUSED entries; past that, every write of the
connection is refused with a non-retryable error (fail closed, never
evicting a live entry).  Nothing expires by time: the state lives exactly as
long as its connection.

Every write path decides in the order requests reach the stream: a set or
setMany is checked when its batch commits, in queue (arrival) order; any
other write first drains that queue, then is checked
(PersistentStream.runOrdered).  wseqs are per PersistStreamClient, and that
client writes to one stream only, so they are contiguous there: the gap rule
above makes the order hold even if the transport reorders.
*/

import { ConatError } from "@cocalc/conat/core/client";

export const MAX_REFUSED = 10_000;

export interface WriteOrder {
  state: WriteOrderState;
  wseq: number;
  wfloor: number;
}

export type OrderVerdict = "ok" | "blocked" | "stale" | "overflow";

export class WriteOrderState {
  // the highest wfloor seen (monotonic)
  floor = 0;
  // every wseq in [floor, next) was seen here (checked: admitted, refused or
  // failed)
  private next = 0;
  // refused wseqs not yet resolved, ascending
  private refused: number[] = [];
  private overflowed = false;

  // where a write may go, before anything of it is applied
  check = (wseq: number, wfloor: number): OrderVerdict => {
    if (this.overflowed) return "overflow";
    if (wseq < this.floor) return "stale";
    if (wfloor > this.floor) {
      this.floor = wfloor;
      while (this.refused.length > 0 && this.refused[0] < this.floor) {
        this.refused.shift();
      }
    }
    if (this.next < this.floor) this.next = this.floor;
    // an earlier write not seen yet: blocked
    if (wseq > this.next) return "blocked";
    if (wseq == this.next) this.next += 1;
    if (this.refused.length > 0 && this.refused[0] < wseq) return "blocked";
    return "ok";
  };

  // the write was refused (by the order or by the budget): false = no room
  // to record it (the state is now overflowed: fail closed)
  noteRefused = (wseq: number): boolean => {
    const i = this.indexOf(wseq);
    if (this.refused[i] === wseq) return true;
    if (this.refused.length >= MAX_REFUSED) {
      this.overflowed = true;
      return false;
    }
    this.refused.splice(i, 0, wseq);
    return true;
  };

  noteAdmitted = (wseq: number): void => {
    const i = this.indexOf(wseq);
    if (this.refused[i] === wseq) this.refused.splice(i, 1);
  };

  refusedCount = (): number => this.refused.length;

  // first index with refused[i] >= wseq
  private indexOf = (wseq: number): number => {
    let lo = 0;
    let hi = this.refused.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.refused[mid] < wseq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

// the order headers of a request: absent -> no order (an in-process or older
// client); present -> strictly validated, else an error (never ignored)
export function parseWriteOrder(
  request: { wseq?: unknown; wfloor?: unknown },
  state: WriteOrderState,
): WriteOrder | undefined {
  if (request?.wseq == null && request?.wfloor == null) return;
  const { wseq, wfloor } = request;
  if (
    typeof wseq != "number" ||
    typeof wfloor != "number" ||
    !Number.isSafeInteger(wseq) ||
    !Number.isSafeInteger(wfloor) ||
    wfloor < 1 ||
    wseq < wfloor
  ) {
    throw new ConatError("persist: invalid write order (wseq, wfloor)", {
      code: 400,
    });
  }
  return { state, wseq, wfloor };
}

// a stale copy of a write the client already resolved, or no room for the
// order state: never applied, never resent
export function writeOrderError(verdict: "stale" | "overflow"): ConatError {
  return new ConatError(
    verdict == "stale"
      ? "persist: a stale copy of a write this client already resolved; not applied"
      : "persist: too many refused writes on this connection; reconnect",
    { code: verdict == "stale" ? "write_stale" : "write_order_overflow" },
  );
}
