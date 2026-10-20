/*
The fence on the board write service (board stream design A2b, section 5a).

A board write is settled only by a reply, or by proof that the process that
could have accepted it is gone. That proof is the process's instance nonce:
- each process serving persist-board-write holds an exclusive lock on one
  host-local lock file for its whole life (project-host/board/write-lock.ts)
  and chooses a fresh random nonce only after taking it;
- every mutating request carries the nonce it was sent for
  (`expectedNonce`), and the server refuses any other one ("instance")
  before it changes anything, so only that process can accept it;
- so a client that later reads a different nonce knows the process that
  could have accepted its write has exited.

A mutating request also carries a time to live (`ttlMs`, at most 25 s). The
server counts it from when the request reached it, on its own monotonic
clock, and refuses ("ttl") a request that waited longer. That only drops
requests that queued too long; it is not what settles a write.

All of these checks are synchronous and run immediately before the store,
in the same step (persist/server.ts), so nothing is stored by a request that
fails one.
*/

import { ConatError } from "@cocalc/conat/core/client";

// What a process serving persist-board-write proves about itself.
export interface BoardWriteFence {
  // 32 lowercase hex digits (128 random bits), fixed for the process.
  readonly nonce: string;
  // Throws if this process may not write board streams now (its lock is
  // invalid or was replaced). Synchronous.
  assertWritable(): void;
}

export const BOARD_WRITE_MAX_TTL_MS = 25_000;

// What a board writer sends with every mutating request: the nonce of the
// one server process it may be accepted by, and its time to live. It is fixed
// for the writer's stream: a write refused "instance" is never re-signed with
// a new nonce; a new writer (with a new stream) is opened instead.
export interface WriteFence {
  expectedNonce: string;
  ttlMs: number;
}

// The commands that only read. Every other request is fenced, including any
// command added later (fail closed, as board-policy.ts does for readers).
const READS = new Set([
  "get",
  "getAll",
  "changefeed",
  "keys",
  "serverId",
  "inventory",
  "checkpoints",
  "metadata",
  "boardInstance",
]);

// Whether this request changes a board stream (and so must pass the fence).
export function isFencedRequest(request: {
  cmd?: unknown;
  config?: unknown;
}): boolean {
  const cmd = `${request?.cmd ?? ""}`;
  if (READS.has(cmd)) return false;
  // Reading the configuration is a read; changing it is not.
  if (cmd === "config" && request?.config == null) return false;
  return true;
}

const NONCE = /^[0-9a-f]{32}$/;

export function isBoardWriteNonce(nonce: unknown): nonce is string {
  return typeof nonce === "string" && NONCE.test(nonce);
}

/*
Throws unless this request may change a board stream now. For reads it does
nothing. `receivedAt` and `now` are performance.now() values: when the
request reached the server, and now.
*/
export function assertBoardWriteFence({
  fence,
  request,
  receivedAt,
  now,
}: {
  fence: BoardWriteFence | undefined;
  request: {
    cmd?: unknown;
    config?: unknown;
    expectedNonce?: unknown;
    ttlMs?: unknown;
  };
  receivedAt: number;
  now: number;
}): void {
  if (!isFencedRequest(request)) return;
  if (fence == null) {
    throw new ConatError("board writes are unavailable on this server", {
      code: "lock",
    });
  }
  try {
    fence.assertWritable();
  } catch (err) {
    throw new ConatError(`board writes are unavailable: ${err}`, {
      code: "lock",
    });
  }
  if (request.expectedNonce !== fence.nonce) {
    throw new ConatError("this write was sent to another server instance", {
      code: "instance",
    });
  }
  const ttl = request.ttlMs;
  if (
    typeof ttl !== "number" ||
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    ttl > BOARD_WRITE_MAX_TTL_MS
  ) {
    throw new ConatError("a board write needs a time to live", {
      code: "ttl",
    });
  }
  if (!(now - receivedAt <= ttl)) {
    throw new ConatError("this write waited too long and was not stored", {
      code: "ttl",
    });
  }
}
