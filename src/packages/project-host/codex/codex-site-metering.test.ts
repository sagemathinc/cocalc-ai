/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

const mockCallHub = jest.fn();
const mockLogger = {
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

type Row = {
  id: number;
  kind: "usage" | "finish";
  payload: string;
};

let rows: Row[] = [];
let nextId = 1;
// Writes that fail as if another connection held the database lock.
let lockedWrites = 0;
let lockedReads = 0;

const mockDatabase = {
  exec: jest.fn(),
  prepare: jest.fn((sql: string) => {
    if (sql.includes("INSERT INTO site_funded_codex_outbox")) {
      return {
        run: (kind: Row["kind"], payload: string) => {
          if (lockedWrites > 0) {
            lockedWrites -= 1;
            throw new Error("database is locked");
          }
          rows.push({ id: nextId++, kind, payload });
        },
      };
    }
    if (sql.includes("SELECT id, kind, payload")) {
      return {
        all: (cursor: number, limit: number) => {
          if (lockedReads > 0) {
            lockedReads -= 1;
            throw new Error("database is locked");
          }
          return rows.filter(({ id }) => id > cursor).slice(0, limit);
        },
      };
    }
    if (sql.includes("DELETE FROM site_funded_codex_outbox")) {
      return {
        run: (id: number) => {
          rows = rows.filter((row) => row.id !== id);
        },
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }),
};

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => mockLogger,
}));
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockCallHub(...args),
}));
jest.mock("../master-conat-client", () => ({
  getMasterConatClient: () => ({}),
}));
jest.mock("../sqlite/hosts", () => ({
  getLocalHostId: () => "11111111-1111-4111-8111-111111111111",
}));
jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getDatabase: () => mockDatabase,
  initDatabase: () => mockDatabase,
}));

import { DEFAULT_SITE_FUNDED_CODEX_POLICY } from "@cocalc/util/ai/site-funded-codex";
import {
  finishSiteFundedTurn,
  flushSiteFundedCodexOutbox,
  persistSiteFundedUsageEvent,
} from "./codex-site-metering";

function usageEvent(requestSequence: number, inputTokens = 1_000) {
  return {
    eventId: `event-${requestSequence}`,
    reservationId: "reservation-1",
    requestSequence,
    model: DEFAULT_SITE_FUNDED_CODEX_POLICY.model,
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    durationMs: 1_000,
  };
}

function queued(): { kind: string; requestSequence?: number }[] {
  return rows.map((row) => ({
    kind: row.kind,
    requestSequence: JSON.parse(row.payload).requestSequence,
  }));
}

function usage(id: number, reservationId: string): Row {
  return {
    id,
    kind: "usage",
    payload: JSON.stringify({ reservationId, eventId: `event-${id}` }),
  };
}

function finish(id: number, reservationId: string): Row {
  return {
    id,
    kind: "finish",
    payload: JSON.stringify({ reservation_id: reservationId }),
  };
}

beforeEach(() => {
  rows = [];
  nextId = 1;
  lockedWrites = 0;
  lockedReads = 0;
  mockCallHub.mockReset();
  mockLogger.error.mockReset();
  mockLogger.warn.mockReset();
  mockDatabase.exec.mockClear();
  mockDatabase.prepare.mockClear();
});

describe("site-funded Codex durable outbox", () => {
  it("discards terminally stale usage and continues later reservations", async () => {
    rows = [
      usage(1, "stale"),
      finish(2, "stale"),
      usage(3, "current"),
      finish(4, "current"),
    ];
    mockCallHub.mockImplementation(async ({ name, args }) => {
      const payload = args[0]?.event ?? args[0];
      if (
        name === "hosts.recordSiteFundedCodexUsageEvent" &&
        payload.reservationId === "stale"
      ) {
        throw new Error(
          "site-funded Codex reservation is not active (expired)",
        );
      }
      return {};
    });

    await flushSiteFundedCodexOutbox();

    expect(rows).toEqual([]);
    expect(mockCallHub).toHaveBeenCalledTimes(4);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "discarding stale site-funded Codex usage outbox row",
      expect.objectContaining({ reservationId: "stale" }),
    );
  });

  it("does not let one transiently blocked reservation stop another", async () => {
    rows = [
      usage(1, "blocked"),
      finish(2, "blocked"),
      usage(3, "healthy"),
      finish(4, "healthy"),
    ];
    mockCallHub.mockImplementation(async ({ name, args }) => {
      const payload = args[0]?.event ?? args[0];
      if (
        name === "hosts.recordSiteFundedCodexUsageEvent" &&
        payload.reservationId === "blocked"
      ) {
        throw new Error("temporary network failure");
      }
      return {};
    });

    await flushSiteFundedCodexOutbox();

    expect(rows).toEqual([usage(1, "blocked"), finish(2, "blocked")]);
    // The second pass retries the blocked usage after healthy rows advance.
    expect(mockCallHub).toHaveBeenCalledTimes(4);
    expect(mockCallHub).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: "hosts.finishSiteFundedCodexTurn",
        args: [{ reservation_id: "blocked" }],
      }),
    );
  });
});

describe("site-funded usage during a database lock", () => {
  beforeEach(() => {
    // The hub is unreachable: rows stay queued, so the test can see them.
    mockCallHub.mockRejectedValue(new Error("hub unavailable"));
  });

  it("saves usage once a brief lock clears, without failing the turn", async () => {
    lockedWrites = 2;
    await expect(persistSiteFundedUsageEvent(usageEvent(1))).resolves.toBe(
      undefined,
    );
    expect(queued()).toEqual([{ kind: "usage", requestSequence: 1 }]);
  });

  it("does not fail usage that was saved when only sending it fails", async () => {
    lockedReads = 1;
    await expect(persistSiteFundedUsageEvent(usageEvent(1))).resolves.toBe(
      undefined,
    );
    expect(queued()).toEqual([{ kind: "usage", requestSequence: 1 }]);
  });

  it("keeps usage in memory through a long lock, pauses only when it lasts, and saves it all in order", async () => {
    lockedWrites = Number.POSITIVE_INFINITY;
    await expect(persistSiteFundedUsageEvent(usageEvent(1))).resolves.toBe(
      undefined,
    );
    await expect(persistSiteFundedUsageEvent(usageEvent(2))).resolves.toBe(
      undefined,
    );
    // The third unsaved event in a row: stop funding the turn.
    await expect(persistSiteFundedUsageEvent(usageEvent(3))).rejects.toThrow(
      "could not be saved",
    );
    const settled = finishSiteFundedTurn({
      reservation_id: "reservation-1",
      status: "committed",
    });
    expect(rows).toEqual([]);
    lockedWrites = 0;
    await settled;
    await flushSiteFundedCodexOutbox();
    // Usage in sequence, then the settlement after it.
    expect(queued()).toEqual([
      { kind: "usage", requestSequence: 1 },
      { kind: "usage", requestSequence: 2 },
      { kind: "usage", requestSequence: 3 },
      { kind: "finish", requestSequence: undefined },
    ]);
  });

  it("pauses at once when the unsaved usage costs more than a small bound", async () => {
    lockedWrites = Number.POSITIVE_INFINITY;
    await expect(
      persistSiteFundedUsageEvent(usageEvent(1, 100_000_000)),
    ).rejects.toThrow("could not be saved");
    lockedWrites = 0;
    await flushSiteFundedCodexOutbox();
    expect(queued()).toEqual([{ kind: "usage", requestSequence: 1 }]);
  });
});
