/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  interruptAiSessionForAccount,
  listAiSessionsForAccount,
  markHostStoppedAiSessions,
  markStaleAiSessionsPossiblyActive,
  runAiSessionReconciliationMaintenanceTick,
  upsertProjectHostAiSession,
} from "./acp-sessions";

let mockInterruptAcp: jest.Mock;
let mockConat: jest.Mock;

jest.mock("@cocalc/conat/ai/acp/client", () => ({
  interruptAcp: (...args: any[]) => mockInterruptAcp(...args),
}));

jest.mock("@cocalc/backend/conat", () => ({
  conat: (...args: any[]) => mockConat(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const HOST_ID = "33333333-3333-4333-8333-333333333333";

async function seedSession({
  session_key = "session-key",
  state = "running",
  terminal = false,
}: {
  session_key?: string;
  state?: "queued" | "running" | "completed" | "failed" | "interrupted";
  terminal?: boolean;
} = {}) {
  await upsertProjectHostAiSession({
    authenticated_project_id: PROJECT_ID,
    record: {
      session_key,
      session_id: `session-id-${session_key}`,
      op_id: `op-id-${session_key}`,
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      host_id: HOST_ID,
      path: "work/test.chat",
      thread_id: `thread-${session_key}`,
      message_id: `message-${session_key}`,
      parent_message_id: `parent-${session_key}`,
      state,
      terminal,
      payment_source_kind: "account",
      payment_source_id: ACCOUNT_ID,
      payment_source_label: "User account",
      model: "codex-test",
      agent_kind: "codex",
      run_kind: "chat",
      title: "Test turn",
      prompt_snippet: "please test",
      queued_at: "2026-06-17T00:00:00.000Z",
      started_at: "2026-06-17T00:00:01.000Z",
      updated_at: "2026-06-17T00:00:02.000Z",
      last_heartbeat_at: "2026-06-17T00:00:03.000Z",
    },
  });
}

describe("AI ACP session registry interrupts", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  beforeEach(() => {
    mockInterruptAcp = jest.fn();
    mockConat = jest.fn(async () => ({ kind: "mock-conat" }));
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await getPool().query("TRUNCATE ai_sessions CASCADE");
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("keeps a session visible as possibly active when interrupt transport fails", async () => {
    await seedSession();
    mockInterruptAcp.mockRejectedValue(new Error("timeout"));

    await expect(
      interruptAiSessionForAccount({
        account_id: ACCOUNT_ID,
        session_key: "session-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      state: "transport_failed",
      terminal: false,
      session_key: "session-key",
    });

    await expect(
      listAiSessionsForAccount({
        account_id: ACCOUNT_ID,
        opts: { activeOnly: true },
      }),
    ).resolves.toMatchObject([
      expect.objectContaining({
        session_key: "session-key",
        state: "possibly_active",
        terminal: false,
      }),
    ]);
  });

  it("marks a session terminal only after the backend acknowledges interruption", async () => {
    await seedSession();
    mockInterruptAcp.mockResolvedValue({ ok: true, state: "interrupted" });

    await expect(
      interruptAiSessionForAccount({
        account_id: ACCOUNT_ID,
        session_key: "session-key",
      }),
    ).resolves.toMatchObject({
      ok: true,
      state: "interrupted",
      terminal: true,
      session_key: "session-key",
    });

    await expect(
      listAiSessionsForAccount({
        account_id: ACCOUNT_ID,
        opts: { activeOnly: true },
      }),
    ).resolves.toEqual([]);
  });

  it("treats backend missing as a terminal repair, not a frontend guess", async () => {
    await seedSession();
    mockInterruptAcp.mockResolvedValue({ ok: true, state: "missing" });

    await expect(
      interruptAiSessionForAccount({
        account_id: ACCOUNT_ID,
        session_key: "session-key",
      }),
    ).resolves.toMatchObject({
      ok: true,
      state: "missing",
      terminal: true,
      session_key: "session-key",
    });

    const { rows } = await getPool().query(
      "SELECT state, terminal, error FROM ai_sessions WHERE session_key=$1",
      ["session-key"],
    );
    expect(rows).toEqual([
      {
        state: "interrupted",
        terminal: true,
        error: "interrupt reported no live session",
      },
    ]);
  });

  it("keeps queued interrupts nonterminal", async () => {
    await seedSession();
    mockInterruptAcp.mockResolvedValue({ ok: true, state: "queued" });

    await expect(
      interruptAiSessionForAccount({
        account_id: ACCOUNT_ID,
        session_key: "session-key",
      }),
    ).resolves.toMatchObject({
      ok: true,
      state: "queued",
      terminal: false,
      session_key: "session-key",
    });

    await expect(
      listAiSessionsForAccount({
        account_id: ACCOUNT_ID,
        opts: { activeOnly: true },
      }),
    ).resolves.toHaveLength(1);
  });

  it("marks stale heartbeat sessions possibly active", async () => {
    await seedSession();
    await getPool().query(
      `UPDATE ai_sessions
          SET updated_at=NOW() - INTERVAL '10 minutes',
              last_heartbeat_at=NOW() - INTERVAL '10 minutes'
        WHERE session_key=$1`,
      ["session-key"],
    );

    await expect(
      markStaleAiSessionsPossiblyActive({ olderThanMs: 2 * 60 * 1000 }),
    ).resolves.toBe(1);

    await expect(
      listAiSessionsForAccount({
        account_id: ACCOUNT_ID,
        opts: { activeOnly: true },
      }),
    ).resolves.toMatchObject([
      expect.objectContaining({
        session_key: "session-key",
        state: "possibly_active",
        terminal: false,
      }),
    ]);
  });

  it("marks sessions terminal when the project host is stopped", async () => {
    await seedSession();

    await expect(markHostStoppedAiSessions({ host_id: HOST_ID })).resolves.toBe(
      1,
    );

    await expect(
      listAiSessionsForAccount({
        account_id: ACCOUNT_ID,
        opts: { activeOnly: true },
      }),
    ).resolves.toEqual([]);
  });

  it("runs stale heartbeat reconciliation as a maintenance tick", async () => {
    await seedSession();
    await getPool().query(
      `UPDATE ai_sessions
          SET updated_at=NOW() - INTERVAL '10 minutes',
              last_heartbeat_at=NOW() - INTERVAL '10 minutes'
        WHERE session_key=$1`,
      ["session-key"],
    );

    await expect(runAiSessionReconciliationMaintenanceTick()).resolves.toBe(1);

    await expect(
      listAiSessionsForAccount({
        account_id: ACCOUNT_ID,
        opts: { activeOnly: true },
      }),
    ).resolves.toMatchObject([
      expect.objectContaining({
        session_key: "session-key",
        state: "possibly_active",
        terminal: false,
      }),
    ]);
  });
});
