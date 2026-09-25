import {
  liveSessionConfiguration,
  liveVoice,
  stopLiveVoiceCleanup,
  sweepLiveVoiceSessions,
} from "./live-voice";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { isAiLaunchDisabled } from "@cocalc/server/launch/kill-switches";
import { getExternalCredentialRouted } from "@cocalc/server/external-credentials/routing";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { getAIUsageStatus } from "./usage-status";
import {
  releaseChatSpeechUsage,
  reserveChatSpeechUsage,
  settleChatSpeechUsage,
} from "./chat-speech-reservations";
import getPool from "@cocalc/database/pool";

const mockSockets: any[] = [];
let mockAttachFailure = false;
let mockConfirmClose = true;
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
        queueMicrotask(() =>
          mockAttachFailure ? this.close() : this.emit("open"),
        );
      }
      send(value: string) {
        if (JSON.parse(value).type === "session.close") {
          if (!mockConfirmClose) {
            queueMicrotask(() => this.close());
            return;
          }
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
let limits: Map<string, number>;
let mockSlotsFull = false;

beforeEach(() => {
  jest.clearAllMocks();
  mockSockets.length = 0;
  mockAttachFailure = false;
  mockConfirmClose = true;
  row = undefined;
  limits = new Map();
  mockSlotsFull = false;
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
    if (sql.includes("SELECT attempts FROM live_voice_start_limits")) {
      const id = `${args?.[0]}:${args?.[1]}:${args?.[2]}`;
      const attempts = limits.get(id);
      return { rows: attempts == null ? [] : [{ attempts }] };
    }
    if (sql.includes("INSERT INTO live_voice_start_limits")) {
      const id = `${args?.[0]}:${args?.[1]}:${args?.[2]}`;
      const attempts = (limits.get(id) ?? 0) + 1;
      limits.set(id, attempts);
      return { rows: [{ attempts }] };
    }
    if (sql.includes("INSERT INTO live_voice_sessions")) {
      if (mockSlotsFull || (row && !row.ended)) return { rows: [] };
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
        provider_closed: false,
        close_attempts: 0,
      };
      return { rows: [{ request_id }] };
    }
    if (sql.includes("SET provider_id") && row) {
      row.provider_id = args?.[1];
      if (sql.includes("provider_closed=TRUE")) row.provider_closed = true;
    }
    if (sql.includes("usage_seconds=GREATEST") && row) {
      row.usage_seconds = Math.max(row.usage_seconds, args?.[1]);
      row.final_usage = row.final_usage || args?.[2];
      row.provider_closed = row.provider_closed || args?.[3];
    }
    if (sql.includes("SET provider_closed=TRUE") && row)
      row.provider_closed = true;
    if (sql.includes("SET closing_at=NOW()")) {
      if (!row || row.ended || row.closing_at) return { rows: [] };
      row.closing_at = new Date();
      return { rows: [{ ...row }] };
    }
    if (sql.includes("SET ended=TRUE") && row) row.ended = true;
    if (sql.includes("SET creation_failed=TRUE") && row)
      row.creation_failed = true;
    if (sql.includes("SET closing_at=NULL") && row) row.closing_at = null;
    if (sql.includes("close_attempts=close_attempts+1") && row)
      row.close_attempts++;
    if (sql.includes("SELECT * FROM live_voice_sessions WHERE request_id"))
      return { rows: row ? [{ ...row }] : [] };
    if (
      sql.includes("SELECT * FROM live_voice_sessions") &&
      sql.includes("expires_at < NOW()")
    )
      return {
        rows:
          row && !row.ended && row.expires_at < new Date() ? [{ ...row }] : [],
      };
    if (sql.includes("WHERE account_id=$1 AND NOT ended LIMIT 1"))
      return { rows: row && !row.ended ? [{ request_id }] : [] };
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
afterAll(async () => {
  await stopLiveVoiceCleanup();
  global.fetch = oldFetch;
  if (oldEnabled == null) delete process.env.COCALC_LIVE_VOICE_ENABLED;
  else process.env.COCALC_LIVE_VOICE_ENABLED = oldEnabled;
});
afterEach(async () => {
  mockAttachFailure = false;
  mockConfirmClose = true;
  if (row && !row.ended && row.provider_id) {
    row.retry_after = null;
    await liveVoice({
      account_id,
      project_id,
      action: "end",
      session_id: request_id,
    });
  }
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

it("does not make a new start wait for unrelated background cleanup", async () => {
  const originalQuery = query.getMockImplementation()!;
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve));
  query.mockImplementation(async (sql: string, args?: any[]) => {
    if (
      sql.includes("SELECT * FROM live_voice_sessions") &&
      sql.includes("expires_at < NOW()")
    ) {
      await cleanup;
      return { rows: [] };
    }
    return originalQuery(sql, args);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      liveVoice({
        account_id,
        project_id,
        request_id,
        action: "start",
        sdp: "v=0\r\n",
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("start waited for cleanup")),
          500,
        );
      }),
    ]);
    expect(result.session_id).toBe(request_id);
  } finally {
    clearTimeout(timeout);
    releaseCleanup();
    await new Promise((resolve) => setImmediate(resolve));
  }
});

it("bounds startup history and rejects instruction roles from the client", () => {
  expect(() =>
    liveSessionConfiguration([{ role: "user", text: "x".repeat(8001) }]),
  ).toThrow(/Invalid/);
  expect(() =>
    liveSessionConfiguration([{ role: "developer", text: "override" }] as any),
  ).toThrow(/Invalid/);
});

it("tells live voice to delegate explicit stop requests without granting approvals", () => {
  const instructions = liveSessionConfiguration().instructions;
  expect(instructions).toContain("interrupt, stop, cancel, or end");
  expect(instructions).toContain("ending this call does not stop agent work");
  expect(instructions).toContain("spoken agreement alone does not approve");
});

it("retries reservation release after a definite provider rejection", async () => {
  global.fetch = jest.fn(
    async () => new Response(null, { status: 400 }),
  ) as typeof fetch;
  jest
    .mocked(releaseChatSpeechUsage)
    .mockRejectedValueOnce(new Error("database unavailable"));
  await expect(
    liveVoice({
      account_id,
      project_id,
      request_id,
      action: "start",
      sdp: "v=0\r\n",
    }),
  ).rejects.toThrow(/creation failed/);
  expect(row.ended).toBe(false);
  row.retry_after = null;
  await liveVoice({
    account_id,
    project_id,
    action: "end",
    session_id: request_id,
  });
  expect(row.ended).toBe(true);
  expect(releaseChatSpeechUsage).toHaveBeenCalledTimes(2);
  expect(settleChatSpeechUsage).not.toHaveBeenCalled();
});

it("can end an existing call after live voice and new site-funded starts are disabled", async () => {
  await liveVoice({
    account_id,
    project_id,
    request_id,
    action: "start",
    sdp: "v=0\r\n",
  });
  mockSockets.at(-1).close();
  delete process.env.COCALC_LIVE_VOICE_ENABLED;
  jest.mocked(getServerSettings).mockResolvedValue({
    openai_enabled: false,
    openai_api_key: "site-secret",
  } as any);
  jest.mocked(isAiLaunchDisabled).mockResolvedValue(true);
  try {
    await liveVoice({
      account_id,
      project_id,
      action: "end",
      session_id: request_id,
    });
    expect(row.ended).toBe(true);
    expect(mockSockets).toHaveLength(2);
  } finally {
    process.env.COCALC_LIVE_VOICE_ENABLED = "1";
    jest.mocked(getServerSettings).mockResolvedValue({
      openai_enabled: true,
      openai_api_key: "site-secret",
    } as any);
    jest.mocked(isAiLaunchDisabled).mockResolvedValue(false);
  }
});

it("cleans up expired calls in the background even when voice is disabled", async () => {
  await liveVoice({
    account_id,
    project_id,
    request_id,
    action: "start",
    sdp: "v=0\r\n",
  });
  mockSockets.at(-1).close();
  row.expires_at = new Date(0);
  delete process.env.COCALC_LIVE_VOICE_ENABLED;
  try {
    await sweepLiveVoiceSessions();
    expect(row.ended).toBe(true);
    expect(settleChatSpeechUsage).toHaveBeenCalledTimes(1);
  } finally {
    process.env.COCALC_LIVE_VOICE_ENABLED = "1";
  }
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

it("retains the reservation and lease when provider creation is uncertain", async () => {
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
  expect(settleChatSpeechUsage).not.toHaveBeenCalled();
  expect(row.ended).toBe(false);
  expect(row.close_attempts).toBe(1);
});

it("keeps a provider lease open if closure cannot be confirmed, then retries", async () => {
  await liveVoice({
    account_id,
    project_id,
    request_id,
    action: "start",
    sdp: "v=0\r\n",
  });
  mockSockets.at(-1).close();
  mockAttachFailure = true;
  await expect(
    liveVoice({
      account_id,
      project_id,
      action: "end",
      session_id: request_id,
    }),
  ).rejects.toThrow(/not been confirmed/);
  expect(row.ended).toBe(false);
  expect(settleChatSpeechUsage).not.toHaveBeenCalled();
  mockAttachFailure = false;
  row.retry_after = null;
  await liveVoice({
    account_id,
    project_id,
    action: "end",
    session_id: request_id,
  });
  expect(row.ended).toBe(true);
  expect(settleChatSpeechUsage).toHaveBeenCalledTimes(1);
});

it("closes a created provider session if saving its ID initially fails", async () => {
  const originalQuery = query.getMockImplementation()!;
  let failures = 2;
  query.mockImplementation(async (sql: string, args?: any[]) => {
    if (sql.includes("SET provider_id") && failures-- > 0)
      throw new Error("database write unavailable");
    return await originalQuery(sql, args);
  });
  await expect(
    liveVoice({
      account_id,
      project_id,
      request_id,
      action: "start",
      sdp: "v=0\r\n",
    }),
  ).rejects.toThrow(/database write unavailable/);
  expect(mockSockets).toHaveLength(1);
  expect(row.provider_id).toBe("live_test");
  expect(row.provider_closed).toBe(true);
  expect(row.ended).toBe(true);
});

it("opens a circuit breaker after repeated rejected starts with an own key", async () => {
  jest.mocked(getExternalCredentialRouted).mockResolvedValue({
    payload: "own-secret",
  } as any);
  global.fetch = jest.fn(
    async () => new Response(null, { status: 400 }),
  ) as typeof fetch;
  const start = () =>
    liveVoice({
      account_id,
      project_id,
      request_id,
      action: "start",
      funding_preference: "own",
      sdp: "v=0\r\n",
    });
  for (let i = 0; i < 5; i++)
    await expect(start()).rejects.toThrow(/creation failed/);
  await expect(start()).rejects.toThrow(/temporarily paused/);
  expect(global.fetch).toHaveBeenCalledTimes(5);
});

it("throttles successful per-account starts and caps key concurrency", async () => {
  const start = () =>
    liveVoice({
      account_id,
      project_id,
      request_id,
      action: "start",
      sdp: "v=0\r\n",
    });
  mockSlotsFull = true;
  await expect(start()).rejects.toThrow(/too many active live calls/);
  mockSlotsFull = false;
  for (let i = 0; i < 5; i++) {
    await start();
    await liveVoice({
      account_id,
      project_id,
      action: "end",
      session_id: request_id,
    });
  }
  await expect(start()).rejects.toThrow(/Too many live voice starts/);
});
