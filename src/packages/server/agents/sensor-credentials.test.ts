export {};

const issue = jest.fn();
const query = jest.fn();
const bearer = jest.fn();
const begin = jest.fn();
const renew = jest.fn();
const end = jest.fn();
const beginCli = jest.fn();

jest.mock("./store", () => ({
  agentStore: () => ({
    issue: (...args: any[]) => issue(...args),
    query: (...args: any[]) => query(...args),
  }),
}));
jest.mock("@cocalc/server/conat/api/hosts-connection-auth", () => ({
  issueProjectHostAgentAuthTokenInternalHelper: (...args: any[]) =>
    bearer(...args),
}));
jest.mock("./cocalc-connector-routing", () => ({
  sensorConnectors: {
    begin: (...args: any[]) => begin(...args),
    renew: (...args: any[]) => renew(...args),
    end: (...args: any[]) => end(...args),
    beginCli: (...args: any[]) => beginCli(...args),
  },
}));

const agent = {
  agent_id: "agent",
  project_id: "project",
  path: "/home/user/a.chat",
  thread_id: "t1",
} as any;
const base = {
  agent,
  account_id: "approver",
  host_id: "host",
  run_id: "run",
};
const github = {
  connector: "github",
  token: "ghu_x",
  expires_at: 1,
  description: "@octocat",
};
const cloudflare = { ...github, connector: "cloudflare", token: "cf_x" };

beforeEach(() => {
  jest.clearAllMocks();
  issue.mockResolvedValue({ agent_id: "agent", run_id: "run", token: "id" });
  bearer.mockResolvedValue({ token: "bearer" });
  begin.mockResolvedValue({ turn_id: "turn", secret: "key" });
  beginCli.mockResolvedValue([github, cloudflare]);
  query.mockResolvedValue({ rows: [] });
});

test("every run gets the identity and project token, as the approver", async () => {
  const { issueSensorRunCredentials } = await import("./sensor-credentials");
  const lease = await issueSensorRunCredentials({ ...base, uses: [] });
  expect(lease.credentials).toEqual({
    identity: { agent_id: "agent", run_id: "run", token: "id" },
    bearer: "bearer",
  });
  expect(issue).toHaveBeenCalledWith(agent, "run", "approver");
  expect(bearer).toHaveBeenCalledWith(
    expect.objectContaining({
      host_id: "host",
      account_id: "approver",
      project_id: "project",
    }),
  );
  // No connector is touched unless the spec uses it.
  expect(begin).not.toHaveBeenCalled();
  expect(beginCli).not.toHaveBeenCalled();
  await lease.release();
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("ended_at=now()"),
    ["agent", "run"],
  );
});

test("connectors are narrowed to what the spec uses", async () => {
  const { issueSensorRunCredentials } = await import("./sensor-credentials");
  const lease = await issueSensorRunCredentials({
    ...base,
    uses: ["cocalc", "github"],
  });
  expect(lease.credentials.connector_key).toBe("key");
  expect(lease.credentials.cli_tokens).toEqual([github]);
  // Only the used connectors are requested from the account's home.
  expect(beginCli.mock.calls[0][0].connectors).toEqual(["github"]);
  expect(lease.missing).toEqual([]);
  const ref = begin.mock.calls[0][0].turn_ref;
  expect(ref).toMatchObject({
    chat_path: "/home/user/a.chat",
    thread_id: "t1",
    message_id: "run",
    sensor_run_id: "run",
  });
  await lease.renew();
  expect(renew).toHaveBeenCalledWith(
    expect.objectContaining({ turn_id: "turn", turn_ref: ref }),
  );
  await lease.release();
  expect(end).toHaveBeenCalledWith(
    expect.objectContaining({ turn_id: "turn", account_id: "approver" }),
  );
});

test("connectors the agent lacks are reported, not silently skipped", async () => {
  const { issueSensorRunCredentials } = await import("./sensor-credentials");
  begin.mockResolvedValueOnce(undefined);
  beginCli.mockResolvedValueOnce([]);
  const lease = await issueSensorRunCredentials({
    ...base,
    uses: ["cocalc", "cloudflare"],
  });
  expect(lease.missing).toEqual(["cocalc", "cloudflare"]);
});

test("a failure part way ends what was already issued", async () => {
  const { issueSensorRunCredentials } = await import("./sensor-credentials");
  beginCli.mockRejectedValueOnce(new Error("home bay unavailable"));
  await expect(
    issueSensorRunCredentials({ ...base, uses: ["cocalc", "github"] }),
  ).rejects.toThrow("home bay unavailable");
  expect(end).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("ended_at=now()"),
    ["agent", "run"],
  );
});
