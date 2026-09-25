/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  liveVoice,
  stopLiveVoiceCleanup,
  sweepLiveVoiceSessions,
} from "./live-voice";
import { releaseChatSpeechUsage } from "./chat-speech-reservations";

jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: async () => ({ class: "plus" }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({
    openai_enabled: true,
    openai_api_key: "test-key",
  }),
}));
jest.mock("@cocalc/server/launch/kill-switches", () => ({
  isAiLaunchDisabled: async () => false,
}));
jest.mock("@cocalc/server/external-credentials/routing", () => ({
  getExternalCredentialRouted: async () => undefined,
}));
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  assertProjectCollaboratorAccessAllowRemote: async () => undefined,
}));
jest.mock("./usage-status", () => ({
  getAIUsageStatus: async () => ({ windows: [] }),
}));
jest.mock("./chat-speech-reservations", () => ({
  reserveChatSpeechUsage: jest.fn(),
  releaseChatSpeechUsage: jest.fn(),
  settleChatSpeechUsage: jest.fn(),
}));

const originalFetch = global.fetch;
const originalEnabled = process.env.COCALC_LIVE_VOICE_ENABLED;

beforeAll(async () => {
  await before({ noConat: true });
  process.env.COCALC_LIVE_VOICE_ENABLED = "1";
  global.fetch = jest.fn(
    async () => new Response(null, { status: 400 }),
  ) as typeof fetch;
}, 60_000);
afterAll(async () => {
  await stopLiveVoiceCleanup();
  global.fetch = originalFetch;
  if (originalEnabled == null) delete process.env.COCALC_LIVE_VOICE_ENABLED;
  else process.env.COCALC_LIVE_VOICE_ENABLED = originalEnabled;
  await after();
});

it("persists definite creation failure and retries cleanup without admitting another call", async () => {
  const account_id = uuid(),
    project_id = uuid(),
    request_id = uuid();
  jest
    .mocked(releaseChatSpeechUsage)
    .mockRejectedValueOnce(new Error("temporary release failure"));
  await expect(
    liveVoice({
      account_id,
      project_id,
      request_id,
      action: "start",
      sdp: "v=0\r\n",
    }),
  ).rejects.toThrow(/creation failed/);
  const { rows } = await getPool().query(
    "SELECT * FROM live_voice_sessions WHERE request_id=$1",
    [request_id],
  );
  expect(rows[0]).toMatchObject({
    ended: false,
    creation_failed: true,
    close_attempts: 1,
    provider_id: null,
  });
  await expect(
    liveVoice({
      account_id,
      project_id,
      request_id: uuid(),
      action: "start",
      sdp: "v=0\r\n",
    }),
  ).rejects.toThrow(/already starting or active/);
  await getPool().query(
    "UPDATE live_voice_sessions SET retry_after=NULL, expires_at=NOW()-INTERVAL '2 minutes', heartbeat_at=NOW()-INTERVAL '2 minutes' WHERE request_id=$1",
    [request_id],
  );
  delete process.env.COCALC_LIVE_VOICE_ENABLED;
  await sweepLiveVoiceSessions();
  const ended = await getPool().query(
    "SELECT ended, closing_at FROM live_voice_sessions WHERE request_id=$1",
    [request_id],
  );
  expect(ended.rows[0]).toEqual({ ended: true, closing_at: null });
  expect(releaseChatSpeechUsage).toHaveBeenCalledTimes(2);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
