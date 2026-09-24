import { liveSessionConfiguration, liveVoice } from "./live-voice";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { isAiLaunchDisabled } from "@cocalc/server/launch/kill-switches";
import { getExternalCredentialRouted } from "@cocalc/server/external-credentials/routing";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { getAIUsageStatus } from "./usage-status";
import {
  reserveChatSpeechUsage,
  settleChatSpeechUsage,
} from "./chat-speech-reservations";
import getPool from "@cocalc/database/pool";

const mockSockets: any[] = [];
jest.mock("ws", () => {
  const { EventEmitter } = require("events");
  return {
    __esModule: true,
    default: class extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        super();
        mockSockets.push(this);
        queueMicrotask(() => this.emit("open"));
      }
      send(value: string) {
        if (JSON.parse(value).type === "session.close") {
          queueMicrotask(() =>
            this.emit(
              "message",
              JSON.stringify({
                type: "session.closed",
                usage: { seconds: 25 },
              }),
            ),
          );
        }
      }
      close() {
        this.readyState = 3;
        this.emit("close");
      }
      terminate() {
        this.close();
      }
    },
  };
});
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: jest.fn(),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(),
}));
jest.mock("@cocalc/server/launch/kill-switches", () => ({
  isAiLaunchDisabled: jest.fn(),
}));
jest.mock("@cocalc/server/external-credentials/routing", () => ({
  getExternalCredentialRouted: jest.fn(),
}));
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  assertProjectCollaboratorAccessAllowRemote: jest.fn(),
}));
jest.mock("./usage-status", () => ({
  getAIUsageStatus: jest.fn(),
}));
jest.mock("./chat-speech-reservations", () => ({
  reserveChatSpeechUsage: jest.fn(),
  settleChatSpeechUsage: jest.fn(),
  releaseChatSpeechUsage: jest.fn(),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const account_id = "00000000-0000-4000-8000-000000000001";
const project_id = "00000000-0000-4000-8000-000000000002";
const request_id = "00000000-0000-4000-8000-000000000003";
const oldFetch = global.fetch;
const oldEnabled = process.env.COCALC_LIVE_VOICE_ENABLED;
let query: jest.Mock;
let row: any;

beforeEach(() => {
  jest.clearAllMocks();
  mockSockets.length = 0;
  row = undefined;
  process.env.COCALC_LIVE_VOICE_ENABLED = "1";
  jest.mocked(resolveMembershipForAccount).mockResolvedValue({
    class: "plus",
  } as any);
  jest.mocked(getServerSettings).mockResolvedValue({
    openai_enabled: true,
    openai_api_key: "site-secret",
  } as any);
  jest.mocked(isAiLaunchDisabled).mockResolvedValue(false);
  jest.mocked(getExternalCredentialRouted).mockResolvedValue(undefined);
  jest.mocked(getAIUsageStatus).mockResolvedValue({
    units_per_dollar: 100,
    windows: [
      { window: "5h", used: 25, limit: 100, remaining: 75 },
      { window: "7d", used: 50, limit: 100, remaining: 50 },
    ],
  });
  jest
    .mocked(assertProjectCollaboratorAccessAllowRemote)
    .mockResolvedValue(undefined);
  query = jest.fn(async (sql: string, args?: any[]) => {
    if (sql.includes("INSERT INTO live_voice_sessions")) {
      if (row && !row.ended)
        throw Object.assign(new Error("duplicate session"), { code: "23505" });
      row = {
        request_id,
        account_id,
        project_id,
        funding_source: args?.[4],
        created_at: new Date(),
        expires_at: args?.[3],
        heartbeat_at: new Date(),
        ended: false,
        usage_seconds: 0,
        final_usage: false,
      };
    }
    if (sql.includes("SET provider_id") && row) row.provider_id = args?.[1];
    if (sql.includes("usage_seconds=GREATEST") && row) {
      row.usage_seconds = Math.max(row.usage_seconds, args?.[1]);
      row.final_usage = row.final_usage || args?.[2];
    }
    if (sql.includes("SET closing_at=NOW()")) {
      if (!row || row.ended || row.closing_at) return { rows: [] };
      row.closing_at = new Date();
      return { rows: [{ ...row }] };
    }
    if (sql.includes("SET ended=TRUE") && row) row.ended = true;
    if (sql.includes("SET closing_at=NULL") && row) row.closing_at = null;
    if (sql.includes("SELECT * FROM live_voice_sessions WHERE request_id"))
      return { rows: row ? [{ ...row }] : [] };
    return { rows: [] };
  });
  jest.mocked(getPool).mockReturnValue({ query } as any);
  global.fetch = jest.fn(async (url: string, init: any) => {
    if (url.endsWith("/hangup")) return new Response(null, { status: 204 });
    return new Response(
      JSON.stringify({
        session: { id: "live_test" },
        transport: { sdp: "answer" },
      }),
      { status: 201 },
    );
  }) as typeof fetch;
});
afterAll(() => {
  global.fetch = oldFetch;
  if (oldEnabled == null) delete process.env.COCALC_LIVE_VOICE_ENABLED;
  else process.env.COCALC_LIVE_VOICE_ENABLED = oldEnabled;
});
afterEach(async () => {
  if (row && !row.ended)
    await liveVoice({
      account_id,
      project_id,
      action: "end",
      session_id: request_id,
    });
});

it("fails closed unless enabled", async () => {
  delete process.env.COCALC_LIVE_VOICE_ENABLED;
  expect(
    (await liveVoice({ account_id, project_id, action: "capabilities" }))
      .enabled,
  ).toBe(false);
  await expect(
    liveVoice({ account_id, project_id, action: "start" }),
  ).rejects.toThrow(/not enabled/);
  expect(query).not.toHaveBeenCalled();
});

it("keeps site funding off for free accounts but permits explicit own-key use", async () => {
  jest.mocked(resolveMembershipForAccount).mockResolvedValue({
    class: "free",
  } as any);
  jest.mocked(getExternalCredentialRouted).mockResolvedValue({
    payload: "own-secret",
  } as any);
  const included = await liveVoice({
    account_id,
    project_id,
    action: "capabilities",
  });
  expect(included.enabled).toBe(false);
  expect(included.own_key_available).toBe(true);
  const own = await liveVoice({
    account_id,
    project_id,
    action: "capabilities",
    funding_preference: "own",
  });
  expect(own.enabled).toBe(true);
  expect(own.funding_source).toBe("project");
  await liveVoice({
    account_id,
    project_id,
    request_id,
    action: "start",
    funding_preference: "own",
    sdp: "v=0\r\n",
  });
  expect(reserveChatSpeechUsage).not.toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledWith(
    "https://api.openai.com/v1/live/sessions",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer own-secret",
      }),
    }),
  );
});

it("reserves included allowance and settles confirmed provider duration", async () => {
  const capability = await liveVoice({
    account_id,
    project_id,
    action: "capabilities",
  });
  expect(capability.funding_source).toBe("site");
  expect(capability.allowance?.map((x) => x.remaining_percent)).toEqual([
    75, 50,
  ]);
  const started = await liveVoice({
    account_id,
    project_id,
    request_id,
    action: "start",
    sdp: "v=0\r\n",
  });
  expect(started.session_id).toBe(request_id);
  expect(started.sdp).toBe("answer");
  expect(reserveChatSpeechUsage).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: account_id,
      operation: "live",
      reservedMicrousd: 100000,
    }),
  );
  expect(global.fetch).toHaveBeenCalledWith(
    "https://api.openai.com/v1/live/sessions",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer site-secret",
      }),
    }),
  );
  await liveVoice({
    account_id,
    project_id,
    action: "end",
    session_id: request_id,
  });
  expect(settleChatSpeechUsage).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "live",
      durationMs: 25_000,
      costMicrousd: 20834,
      providerRequestId: "live_test",
    }),
  );
  expect(row.ended).toBe(true);
});

it("bounds startup history and rejects instruction roles from the client", () => {
  expect(() =>
    liveSessionConfiguration([{ role: "user", text: "x".repeat(8001) }]),
  ).toThrow(/Invalid/);
  expect(() =>
    liveSessionConfiguration([{ role: "developer", text: "override" }] as any),
  ).toThrow(/Invalid/);
});

it("does not reserve twice for an uncertain repeated start", async () => {
  const request = {
    account_id,
    project_id,
    request_id,
    action: "start" as const,
    sdp: "v=0\r\n",
  };
  await liveVoice(request);
  await expect(liveVoice(request)).rejects.toThrow(
    /already starting or active/,
  );
  expect(reserveChatSpeechUsage).toHaveBeenCalledTimes(1);
});

it("settles the reserved upper bound when provider creation is uncertain", async () => {
  global.fetch = jest.fn(async () => {
    throw new Error("provider response lost");
  }) as typeof fetch;
  await expect(
    liveVoice({
      account_id,
      project_id,
      request_id,
      action: "start",
      sdp: "v=0\r\n",
    }),
  ).rejects.toThrow(/response lost/);
  expect(settleChatSpeechUsage).toHaveBeenCalledWith(
    expect.objectContaining({ costMicrousd: 100000, durationMs: 120000 }),
  );
  expect(row.ended).toBe(true);
});
