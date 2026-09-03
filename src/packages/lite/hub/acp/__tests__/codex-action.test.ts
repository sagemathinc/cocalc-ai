/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const callHubMock = jest.fn();

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args) => callHubMock(...args),
}));

import {
  createCodexFreshAuthAttention,
  reconcileCodexAction,
} from "../codex-attention";
import { closeAcpDatabase, initAcpDatabase } from "../../sqlite/acp-database";
import { getAcpAttention } from "../../sqlite/acp-attention";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CHALLENGE_ID = "33333333-3333-4333-8333-333333333333";

describe("trusted Codex actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    closeAcpDatabase();
    initAcpDatabase({ filename: ":memory:" });
  });

  afterEach(() => {
    closeAcpDatabase();
  });

  it("registers only a pending bound challenge and resolves on approval", async () => {
    let state = "pending";
    callHubMock.mockImplementation(async ({ name }) => {
      if (name === "notifications.getCodexFreshAuthActionStatus") {
        return {
          challenge_id: CHALLENGE_ID,
          state,
          expires_at: "2099-09-02T01:00:00.000Z",
        };
      }
      return {};
    });
    const record = await createCodexFreshAuthAttention({
      client: {} as any,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      path: "agent.chat",
      thread_id: "thread-1",
      message_date: "2099-09-02T00:00:00.000Z",
      challenge_id: CHALLENGE_ID,
    });
    expect(record).toMatchObject({
      state: "pending",
      source_kind: "cocalc_action",
      attention_kind: "fresh_auth",
      is_blocking: true,
      action: { kind: "fresh_auth", reference: CHALLENGE_ID },
    });
    expect(callHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        name: "notifications.getCodexFreshAuthActionStatus",
      }),
    );

    state = "approved";
    const resolved = await reconcileCodexAction({
      client: {} as any,
      record,
    });
    expect(resolved.state).toBe("resolved");
    expect(getAcpAttention(record.attention_id)?.state).toBe("resolved");
  });

  it("rejects registration after the authority has canceled it", async () => {
    callHubMock.mockResolvedValue({
      challenge_id: CHALLENGE_ID,
      state: "canceled",
      expires_at: "2099-09-02T01:00:00.000Z",
    });
    await expect(
      createCodexFreshAuthAttention({
        client: {} as any,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        path: "agent.chat",
        thread_id: "thread-1",
        challenge_id: CHALLENGE_ID,
      }),
    ).rejects.toThrow("not pending");
  });
});
