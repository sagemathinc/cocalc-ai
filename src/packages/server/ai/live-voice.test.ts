import { liveSessionConfiguration, liveVoice } from "./live-voice";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getExternalCredentialRouted } from "@cocalc/server/external-credentials/routing";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import getPool from "@cocalc/database/pool";

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/external-credentials/routing", () => ({
  getExternalCredentialRouted: jest.fn(),
}));
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  assertProjectCollaboratorAccessAllowRemote: jest.fn(),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
const account_id = "00000000-0000-4000-8000-000000000001";
const project_id = "00000000-0000-4000-8000-000000000002";
const request_id = "00000000-0000-4000-8000-000000000003";
const oldFetch = global.fetch;
const oldSwitch = process.env.COCALC_LIVE_VOICE_DEV;
let query: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.COCALC_LIVE_VOICE_DEV = "1";
  (isAdmin as jest.Mock).mockResolvedValue(true);
  (getExternalCredentialRouted as jest.Mock).mockResolvedValue({
    payload: "test-secret",
  });
  (assertProjectCollaboratorAccessAllowRemote as jest.Mock).mockResolvedValue(
    undefined,
  );
  query = jest.fn(async () => ({ rows: [] }));
  (getPool as jest.Mock).mockReturnValue({ query });
});
afterAll(() => {
  global.fetch = oldFetch;
  if (oldSwitch == null) delete process.env.COCALC_LIVE_VOICE_DEV;
  else process.env.COCALC_LIVE_VOICE_DEV = oldSwitch;
});

it("fails closed unless explicitly enabled and an administrator", async () => {
  delete process.env.COCALC_LIVE_VOICE_DEV;
  expect(
    (await liveVoice({ account_id, project_id, action: "capabilities" }))
      .enabled,
  ).toBe(false);
  expect(getExternalCredentialRouted).not.toHaveBeenCalled();
  process.env.COCALC_LIVE_VOICE_DEV = "1";
  (isAdmin as jest.Mock).mockResolvedValue(false);
  await expect(
    liveVoice({ account_id, project_id, action: "start" }),
  ).rejects.toThrow(/not enabled/);
  expect(query).not.toHaveBeenCalled();
});

it("does not fall back to site funding for the preview", async () => {
  (getExternalCredentialRouted as jest.Mock).mockResolvedValue(undefined);
  const result = await liveVoice({
    account_id,
    project_id,
    action: "capabilities",
  });
  expect(result.enabled).toBe(false);
  expect(result.reason).toMatch(/Site-funded/);
});

it("keeps credentials and configuration on the server and records the session owner", async () => {
  global.fetch = jest.fn(async (_url, init) => {
    expect((init?.headers as any).Authorization).toBe("Bearer test-secret");
    const body = JSON.parse(String(init?.body));
    expect(body.session.delegation).toEqual({ type: "client" });
    expect(body.session.store).toBe(false);
    expect(
      body.session.client.data_channel.allowed_client_events,
    ).not.toContain("session.update");
    return new Response(
      JSON.stringify({
        session: { id: "live_test" },
        transport: { sdp: "answer" },
      }),
      { status: 201 },
    );
  }) as typeof fetch;
  const result = await liveVoice({
    account_id,
    project_id,
    request_id,
    action: "start",
    sdp: "v=0\r\n",
  });
  expect(result.session_id).toBe(request_id);
  expect(result.sdp).toBe("answer");
  expect(JSON.stringify(result)).not.toContain("test-secret");
  expect(JSON.stringify(result)).not.toContain("live_test");
  expect(assertProjectCollaboratorAccessAllowRemote).toHaveBeenCalledWith({
    account_id,
    project_id,
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("INSERT INTO"),
    expect.arrayContaining([account_id, project_id, request_id]),
  );
});

it("does not hang up another account's provider session", async () => {
  global.fetch = jest.fn() as typeof fetch;
  await expect(
    liveVoice({
      account_id,
      project_id,
      action: "end",
      session_id: request_id,
    }),
  ).rejects.toThrow(/not found/);
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("account_id=$2 AND project_id=$3"),
    [request_id, account_id, project_id],
  );
  expect(global.fetch).not.toHaveBeenCalled();
});

it("does not revive an expired heartbeat lease", async () => {
  query.mockResolvedValue({
    rows: [
      {
        ended: false,
        heartbeat_at: new Date(Date.now() - 30_000),
        expires_at: new Date(Date.now() + 60_000),
      },
    ],
  });
  await expect(
    liveVoice({
      account_id,
      project_id,
      action: "heartbeat",
      session_id: request_id,
    }),
  ).rejects.toThrow(/expired/);
  expect(
    query.mock.calls.some(([sql]) => sql.includes("SET heartbeat_at")),
  ).toBe(false);
});

it("bounds startup history and rejects instruction roles from the client", () => {
  expect(() =>
    liveSessionConfiguration([{ role: "user", text: "x".repeat(8001) }]),
  ).toThrow(/Invalid/);
  expect(() =>
    liveSessionConfiguration([{ role: "developer", text: "override" }] as any),
  ).toThrow(/Invalid/);
});
