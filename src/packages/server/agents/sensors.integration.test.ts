import { createHash, randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import getPool from "@cocalc/database/pool";
import { SCHEMA } from "@cocalc/util/db-schema";

const access = { denied: new Set<string>() };
const limits: Record<string, number> = {};
const host = {
  runAgentSensor: jest.fn(),
  deliverAgentSensorWake: jest.fn(),
};
const assertHost = jest.fn(async () => {});

jest.mock("./access", () => ({
  assertActor: async (account_id: string) => {
    if (access.denied.has(account_id)) throw new Error("not a collaborator");
  },
  assertAgent: async (agent: { disabled_at?: unknown }) => {
    if (agent.disabled_at) throw new Error("agent is disabled");
  },
}));
jest.mock("@cocalc/server/accounts/trusted-product-access", () => ({
  getAccountProductAccessTrust: async () => ({ trusted: true }),
}));
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: async () => ({ effective_limits: limits }),
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: (...args: unknown[]) =>
    assertHost(...(args as [])),
}));
jest.mock("./rpc", () => ({
  hostFor: async () => ({ host_id: "host", api: host }),
}));
// The credentials a run gets (sensor-credentials.test.ts covers issuance).
const lease = {
  missing: [] as string[],
  issued: [] as any[],
  released: 0,
  fail: "",
};
jest.mock("./sensor-credentials", () => ({
  issueSensorRunCredentials: async (opts: any) => {
    if (lease.fail) throw new Error(lease.fail);
    lease.issued.push(opts);
    return {
      credentials: {
        identity: { agent_id: opts.agent.agent_id, run_id: opts.run_id },
        bearer: "bearer",
      },
      missing: lease.missing,
      given: opts.uses.filter((c: string) => !lease.missing.includes(c)),
      renew: async () => {},
      release: async () => {
        lease.released++;
      },
    };
  },
}));

// Budgets live on the approver's home bay; here that is this database. Every
// call is recorded, to show which account's home is asked.
const budget = { calls: [] as string[], failRelease: false };
// Connectors the account gave the agent, as its home bay reports them.
const grants = { github: true, fail: "" };
jest.mock("./cocalc-connector-routing", () => {
  const home = jest.requireActual("./sensor-budget");
  const call =
    (name: string, fn: (opts: any) => Promise<any>) => async (opts: any) => {
      budget.calls.push(`${name}:${opts.account_id}`);
      if (budget.failRelease && name.startsWith("release"))
        throw new Error("home bay unreachable");
      return await fn(opts);
    };
  return {
    sensorBudget: {
      reserveWake: call("reserveWake", home.reserveSensorWakeAtHome),
      releaseWake: call("releaseWake", home.releaseSensorWakeAtHome),
      reserveWatcher: call("reserveWatcher", home.reserveSensorWatcherAtHome),
      releaseWatcher: call("releaseWatcher", home.releaseSensorWatcherAtHome),
    },
    sensorConnectors: {
      hasCli: async (opts: any) => {
        if (grants.fail) throw new Error(grants.fail);
        return opts.connector === "github" && grants.github;
      },
    },
  };
});

const paused: any[] = [];
jest.mock("./sensor-notify", () => ({
  notifySensorPausedBestEffort: async (opts: any) => {
    paused.push(opts);
  },
}));

import {
  agentSensorRequest,
  authorizeSensorExecutionLocal,
  sensorControlLocal,
  setSensorConsumeHookForTests,
  setSensorManageHookForTests,
} from "./sensors";
import {
  claimDueSensors,
  removeDoneWatchers,
  runClaimedSensor,
  setSensorDispatchHookForTests,
  setSensorIssueHookForTests,
  startSensorScheduler,
} from "./sensor-scheduler";
import { WATCHERS_PER_WAKE } from "./sensor-budget";
import { SENSOR_LIMITS } from "@cocalc/conat/agents/sensors";

const HOST = "44444444-4444-4444-8444-444444444444";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const spec = {
  title: "GitHub: new issues",
  purpose: "Wake me when an issue is opened.",
  language: "sh",
  script: 'echo \'{"wake": true, "summary": "1 new issue"}\'',
  schedule: { kind: "interval", minutes: 30 },
  max_wakes_per_day: 2,
};

describeDb("agent sensors", () => {
  let project_id: string;
  let agent_id: string;
  let owner: string;
  let run: any;
  let agent: any;

  beforeAll(async () => {
    await syncSchema({
      projects: SCHEMA.projects,
      agent_identities: SCHEMA.agent_identities,
      agent_sensors: SCHEMA.agent_sensors,
      agent_sensor_runs: SCHEMA.agent_sensor_runs,
      agent_sensor_events: SCHEMA.agent_sensor_events,
    });
  });

  beforeEach(async () => {
    access.denied.clear();
    for (const key of Object.keys(limits)) delete limits[key];
    lease.missing = [];
    lease.fail = "";
    grants.github = true;
    grants.fail = "";
    lease.issued = [];
    lease.released = 0;
    budget.calls = [];
    budget.failRelease = false;
    paused.length = 0;
    host.runAgentSensor.mockReset().mockResolvedValue({
      exit_code: 0,
      timed_out: false,
      stdout: '{"wake": true, "summary": "1 new issue", "data": {"n": 1}}\n',
      stderr: "",
    });
    host.deliverAgentSensorWake
      .mockReset()
      .mockResolvedValue({ message_id: "m" });
    project_id = randomUUID();
    agent_id = randomUUID();
    owner = randomUUID();
    const pool = getPool();
    await pool.query(
      "INSERT INTO projects (project_id, run_quota, users, host_id, rootfs_image) VALUES ($1, $2, $3, $4, 'img:1')",
      [project_id, { network: true }, { [owner]: { group: "owner" } }, HOST],
    );
    await pool.query(
      `INSERT INTO agent_identities (agent_id, project_id, path, thread_id, name, created_by)
       VALUES ($1, $2, '/home/user/a.chat', 't1', 'watcher', $3)`,
      [agent_id, project_id, owner],
    );
    agent = (
      await pool.query("SELECT * FROM agent_identities WHERE agent_id=$1", [
        agent_id,
      ])
    ).rows[0];
    run = { agent_id, run_id: randomUUID(), account_id: owner, project_id };
  });

  const propose = async (s: unknown = spec, sensor_id?: string) =>
    (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "propose",
      spec: s,
      ...(sensor_id ? { sensor_id } : {}),
    })) as any;

  const approve = async (sensor: any, account_id = owner) =>
    (await sensorControlLocal(account_id, project_id, {
      op: "approve",
      sensor_id: sensor.sensor_id,
      revision: sensor.revision,
    })) as any;

  const makeDue = async (sensor_id: string) =>
    await getPool().query(
      "UPDATE agent_sensors SET next_run_at=now()-interval '1 minute' WHERE sensor_id=$1",
      [sensor_id],
    );

  const runDue = async () => {
    const due = await claimDueSensors();
    for (const row of due) await runClaimedSensor(row);
    return due.length;
  };

  // The agent's queued wake turns start (otherwise later wakes are held).
  const startTurns = async () =>
    await getPool().query(
      "UPDATE agent_sensor_runs SET wake_state='consumed' WHERE wake_state='issued'",
    );

  test("a proposal waits for a person, who approves the exact revision", async () => {
    const { sensor } = await propose();
    expect(sensor).toMatchObject({
      status: "pending",
      spec: null,
      pending_spec: expect.objectContaining({ title: spec.title }),
    });
    expect(await runDue()).toBe(0);
    await expect(
      sensorControlLocal(owner, project_id, {
        op: "approve",
        sensor_id: sensor.sensor_id,
        revision: sensor.revision + 1,
      }),
    ).rejects.toThrow(/changed since you looked/);
    const approved = (await approve(sensor)).sensor;
    expect(approved).toMatchObject({
      status: "active",
      pending_spec: null,
      approved_by: owner,
      spec: expect.objectContaining({ script: spec.script }),
    });
    expect(approved.script_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(approved.next_run_at).not.toBeNull();
  });

  test("proposals respect internet access and the tier's minimum interval", async () => {
    limits.sensor_min_interval_minutes = 60;
    await expect(propose()).rejects.toThrow(/from 60/);
    delete limits.sensor_min_interval_minutes;
    await getPool().query(
      "UPDATE projects SET run_quota=$2 WHERE project_id=$1",
      [project_id, { network: false }],
    );
    await expect(propose()).rejects.toThrow(/internet access/);
    limits.acp_max_active_automations_per_project = 0;
    await expect(propose()).rejects.toThrow(/membership/);
  });

  test("a membership without sensors still has watchers, unless it allows no wakes", async () => {
    // Like the free tier: no approved sensors, but wakes.
    limits.acp_max_active_automations_per_project = 0;
    await expect(propose()).rejects.toThrow(/membership/);
    const watch = async () =>
      (await agentSensorRequest(run, agent, {
        action: "sensor",
        op: "watch",
        watch: {
          type: "at",
          at: new Date(Date.now() + 3_600_000).toISOString(),
          note: "check CI",
        },
      })) as any;
    const { sensor } = await watch();
    expect(sensor).toMatchObject({ status: "active" });
    // It runs, rather than pausing for the membership.
    await makeDue(sensor.sensor_id);
    await runDue();
    const { rows } = await getPool().query(
      "SELECT status, pause_reason FROM agent_sensors WHERE sensor_id=$1",
      [sensor.sensor_id],
    );
    expect(rows[0]).toEqual({ status: "active", pause_reason: null });
    limits.sensor_max_wakes_per_day = 0;
    await expect(watch()).rejects.toThrow(/membership/);
  });

  test("paused watchers are removed a day after they would have given up", async () => {
    const watch = async () =>
      (
        (await agentSensorRequest(run, agent, {
          action: "sensor",
          op: "watch",
          watch: {
            type: "at",
            at: new Date(Date.now() + 3_600_000).toISOString(),
            note: "check CI",
          },
        })) as any
      ).sensor;
    const pausedAt = async (sensor_id: string, expiresAgoMs: number) =>
      await getPool().query(
        `UPDATE agent_sensors SET status='paused',
           spec=jsonb_set(spec, '{expires_at}', to_jsonb($2::text))
         WHERE sensor_id=$1`,
        [sensor_id, new Date(Date.now() - expiresAgoMs).toISOString()],
      );
    const gaveUp = await watch();
    const recent = await watch();
    const active = await watch();
    const revised = await watch();
    await pausedAt(gaveUp.sensor_id, 2 * 86_400_000);
    // Gave up only an hour ago: still listed for a day.
    await pausedAt(recent.sensor_id, 3_600_000);
    // Gave up long ago, but a replacement awaits review: kept.
    await pausedAt(revised.sensor_id, 2 * 86_400_000);
    await getPool().query(
      "UPDATE agent_sensors SET pending_spec=spec WHERE sensor_id=$1",
      [revised.sensor_id],
    );
    await removeDoneWatchers();
    const { rows } = await getPool().query(
      "SELECT sensor_id FROM agent_sensors WHERE sensor_id = ANY($1)",
      [
        [
          gaveUp.sensor_id,
          recent.sensor_id,
          active.sensor_id,
          revised.sensor_id,
        ],
      ],
    );
    expect(rows.map(({ sensor_id }) => sensor_id).sort()).toEqual(
      [recent.sensor_id, active.sensor_id, revised.sensor_id].sort(),
    );
  });

  test("a change keeps the approved version running until approved", async () => {
    const { sensor } = await propose();
    const active = (await approve(sensor)).sensor;
    const changed = (
      await propose({ ...spec, title: "Changed" }, active.sensor_id)
    ).sensor;
    expect(changed).toMatchObject({
      status: "active",
      spec: expect.objectContaining({ title: spec.title }),
      pending_spec: expect.objectContaining({ title: "Changed" }),
    });
    await expect(propose(spec, active.sensor_id)).rejects.toThrow(/identical/);
    const swapped = (await approve(changed)).sensor;
    expect(swapped.spec.title).toBe("Changed");
    expect(swapped.script_hash).not.toBe(active.script_hash);
  });

  test("a wake starts a turn as the approver, within the daily limit", async () => {
    const { sensor } = await propose();
    const active = (await approve(sensor)).sensor;
    for (let i = 0; i < 3; i++) {
      await makeDue(active.sensor_id);
      expect(await runDue()).toBe(1);
      await startTurns();
    }
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(2);
    const delivery = host.deliverAgentSensorWake.mock.calls[0][0];
    expect(delivery).toMatchObject({
      account_id: owner,
      path: "/home/user/a.chat",
      thread_id: "t1",
      authorization: {
        version: 1,
        sensor_id: active.sensor_id,
        project_id,
        agent_id,
        script_hash: active.script_hash,
      },
    });
    expect(delivery.prompt).toMatch(/^\[Sensor wake\] "GitHub: new issues"/);
    expect(delivery.prompt).toContain("This is not a message from a person.");
    const { sensors, runs } = (await sensorControlLocal(owner, project_id, {
      op: "list",
      sensor_id: active.sensor_id,
    })) as any;
    expect(sensors[0]).toMatchObject({
      wakes_today: 2,
      last_outcome: "wake-limited",
    });
    expect(runs.map((r: any) => r.outcome)).toEqual([
      "wake-limited",
      "wake",
      "wake",
    ]);
  });

  test("quiet runs do not wake; repeated failures pause the sensor", async () => {
    const { sensor } = await propose();
    const active = (await approve(sensor)).sensor;
    host.runAgentSensor.mockResolvedValue({
      exit_code: 0,
      timed_out: false,
      stdout: "nothing new\n",
      stderr: "",
    });
    await makeDue(active.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).not.toHaveBeenCalled();
    host.runAgentSensor.mockResolvedValue({
      exit_code: 1,
      timed_out: false,
      stdout: "",
      stderr: "boom",
    });
    for (let i = 0; i < 5; i++) {
      await makeDue(active.sensor_id);
      await runDue();
    }
    const { sensors } = (await sensorControlLocal(owner, project_id, {
      op: "list",
    })) as any;
    expect(sensors[0].status).toBe("paused");
    expect(sensors[0].pause_reason).toMatch(/5 failed runs/);
    await makeDue(active.sensor_id);
    expect(await runDue()).toBe(0);
  });

  test("a sensor stops when its approver loses access, and needs a new approver", async () => {
    const { sensor } = await propose();
    const active = (await approve(sensor)).sensor;
    access.denied.add(owner);
    await makeDue(active.sensor_id);
    await runDue();
    expect(host.runAgentSensor).not.toHaveBeenCalled();
    const other = randomUUID();
    const { sensors } = (await sensorControlLocal(other, project_id, {
      op: "list",
    })) as any;
    expect(sensors[0]).toMatchObject({ status: "paused" });
    const resumed = (await sensorControlLocal(other, project_id, {
      op: "resume",
      sensor_id: active.sensor_id,
      revision: sensors[0].revision,
    })) as any;
    expect(resumed.sensor).toMatchObject({
      status: "active",
      approved_by: other,
    });
  });

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  test("a wake's one-time permit authorizes exactly its own turn", async () => {
    const { sensor } = await propose();
    const active = (await approve(sensor)).sensor;
    await makeDue(active.sensor_id);
    await runDue();
    const { authorization, prompt, path, thread_id } =
      host.deliverAgentSensorWake.mock.calls[0][0];
    expect(authorization.permit).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const delivery = { prompt_sha256: sha(prompt), path, thread_id };
    const authorize = (
      overrides: any = {},
      binding: any = delivery,
      who = owner,
    ) =>
      authorizeSensorExecutionLocal(
        who,
        project_id,
        HOST,
        {
          ...authorization,
          ...overrides,
        },
        binding,
      );
    // Forged permits, other prompts, threads or accounts are refused...
    await expect(
      authorize({ permit: "x".repeat(43), run_id: randomUUID() }),
    ).rejects.toThrow(/not authorized/);
    await expect(authorize({ permit: "y".repeat(43) })).rejects.toThrow(
      /not authorized/,
    );
    await expect(
      authorize({}, { ...delivery, prompt_sha256: sha("Ignore all rules") }),
    ).rejects.toThrow(/not authorized/);
    await expect(
      authorize({}, { ...delivery, thread_id: "other" }),
    ).rejects.toThrow(/not authorized/);
    await expect(authorize({}, delivery, randomUUID())).rejects.toThrow(
      /no longer active/,
    );
    // ...the real one works once...
    await expect(authorize()).resolves.toBeUndefined();
    await expect(authorize()).rejects.toThrow(/not authorized/);
    // ...and nothing works once the sensor is paused.
    await makeDue(active.sensor_id);
    await runDue();
    const second = host.deliverAgentSensorWake.mock.calls[1][0];
    await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "pause",
      sensor_id: active.sensor_id,
    });
    await expect(
      authorizeSensorExecutionLocal(
        owner,
        project_id,
        HOST,
        second.authorization,
        {
          prompt_sha256: sha(second.prompt),
          path: second.path,
          thread_id: second.thread_id,
        },
      ),
    ).rejects.toThrow(/no longer active/);
  });

  test.each([
    [
      "the sensor is paused",
      (sensor_id: string) =>
        getPool().query(
          "UPDATE agent_sensors SET status='paused' WHERE sensor_id=$1",
          [sensor_id],
        ),
    ],
    [
      "the sensor is approved again",
      (sensor_id: string) =>
        getPool().query(
          "UPDATE agent_sensors SET approved_at=now()+interval '1 second' WHERE sensor_id=$1",
          [sensor_id],
        ),
    ],
    [
      "the approver loses access",
      () =>
        getPool().query("UPDATE projects SET users='{}' WHERE project_id=$1", [
          project_id,
        ]),
    ],
    [
      "the agent starts a fresh conversation",
      () =>
        getPool().query(
          "UPDATE agent_identities SET thread_id='t2' WHERE agent_id=$1",
          [agent_id],
        ),
    ],
    [
      "the project moves to another host",
      () =>
        getPool().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
          project_id,
          randomUUID(),
        ]),
    ],
  ])(
    "nothing is consumed if %s right before the permit is used",
    async (_label, revoke) => {
      const active = (await approve((await propose()).sensor)).sensor;
      await makeDue(active.sensor_id);
      await runDue();
      const { authorization, prompt, path, thread_id } =
        host.deliverAgentSensorWake.mock.calls[0][0];
      setSensorConsumeHookForTests(async () => {
        await revoke(active.sensor_id);
      });
      try {
        await expect(
          authorizeSensorExecutionLocal(
            owner,
            project_id,
            HOST,
            authorization,
            {
              prompt_sha256: sha(prompt),
              path,
              thread_id,
            },
          ),
        ).rejects.toThrow(/not authorized/);
      } finally {
        setSensorConsumeHookForTests(undefined);
      }
      const { rows } = await getPool().query(
        "SELECT wake_state FROM agent_sensor_runs WHERE run_id=$1",
        [authorization.run_id],
      );
      expect(rows[0].wake_state).toBe("issued");
    },
  );

  test("control: with nothing revoked at that point, the permit is consumed", async () => {
    const active = (await approve((await propose()).sensor)).sensor;
    await makeDue(active.sensor_id);
    await runDue();
    const { authorization, prompt, path, thread_id } =
      host.deliverAgentSensorWake.mock.calls[0][0];
    const hook = jest.fn(async () => {});
    setSensorConsumeHookForTests(hook);
    try {
      await authorizeSensorExecutionLocal(
        owner,
        project_id,
        HOST,
        authorization,
        {
          prompt_sha256: sha(prompt),
          path,
          thread_id,
        },
      );
    } finally {
      setSensorConsumeHookForTests(undefined);
    }
    expect(hook).toHaveBeenCalledTimes(1);
    const { rows } = await getPool().query(
      "SELECT wake_state FROM agent_sensor_runs WHERE run_id=$1",
      [authorization.run_id],
    );
    expect(rows[0].wake_state).toBe("consumed");
  });

  test("a run gets the agent's access as the approver, in the project's software", async () => {
    const active = (
      await approve((await propose({ ...spec, uses: ["github"] })).sensor)
    ).sensor;
    await makeDue(active.sensor_id);
    await runDue();
    expect(lease.issued[0]).toMatchObject({
      account_id: owner,
      host_id: "host",
      uses: ["github"],
      agent: expect.objectContaining({ agent_id }),
    });
    expect(lease.issued[0].run_id).toBe(
      host.runAgentSensor.mock.calls[0][0].run_id,
    );
    expect(host.runAgentSensor.mock.calls[0][0]).toMatchObject({
      image: "img:1",
      credentials: { bearer: "bearer" },
      path: "/home/user/a.chat",
    });
    expect(lease.released).toBe(1);
  });

  test("a sensor whose connector is off for the agent pauses instead of running", async () => {
    const active = (
      await approve((await propose({ ...spec, uses: ["github"] })).sensor)
    ).sensor;
    lease.missing = ["github"];
    await makeDue(active.sensor_id);
    await runDue();
    expect(host.runAgentSensor).not.toHaveBeenCalled();
    expect(lease.released).toBe(1);
    const { sensors } = (await sensorControlLocal(owner, project_id, {
      op: "list",
    })) as any;
    expect(sensors[0].status).toBe("paused");
    expect(sensors[0].pause_reason).toMatch(/uses GitHub/);
    // The person it runs as is told, once.
    expect(paused).toEqual([
      expect.objectContaining({
        account_id: owner,
        project_id,
        sensor_id: active.sensor_id,
        title: spec.title,
        reason: expect.stringMatching(/uses GitHub/),
      }),
    ]);
  });

  test("the run log records the connectors each run was given", async () => {
    const active = (
      await approve((await propose({ ...spec, uses: ["github"] })).sensor)
    ).sensor;
    await makeDue(active.sensor_id);
    await runDue();
    const { runs } = (await sensorControlLocal(owner, project_id, {
      op: "list",
      sensor_id: active.sensor_id,
    })) as any;
    expect(runs[0].connectors).toEqual(["github"]);
    const shown = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "show",
      sensor_id: active.sensor_id,
    })) as any;
    expect(shown.runs[0].connectors).toEqual(["github"]);
    expect(paused).toEqual([]);
  });

  test("a new approval starts fresh: earlier wakes neither block, ride along nor run", async () => {
    const first = (
      await approve((await propose({ ...spec, max_wakes_per_day: 10 })).sensor)
    ).sensor;
    const woke = (summary: string) => ({
      exit_code: 0,
      timed_out: false,
      stdout: `${JSON.stringify({ wake: true, summary })}\n`,
      stderr: "",
    });
    host.runAgentSensor
      .mockResolvedValueOnce(woke("old one"))
      .mockResolvedValueOnce(woke("old two"))
      .mockResolvedValueOnce(woke("new one"));
    await makeDue(first.sensor_id);
    await runDue();
    await makeDue(first.sensor_id);
    await runDue();
    // "old one" is queued and "old two" held, under the first approval.
    const old = host.deliverAgentSensorWake.mock.calls[0][0];
    const revised = (
      await propose(
        { ...spec, title: "Revised", max_wakes_per_day: 10 },
        first.sensor_id,
      )
    ).sensor;
    await approve(revised);
    await makeDue(first.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(2);
    const fresh = host.deliverAgentSensorWake.mock.calls[1][0].prompt;
    expect(fresh).toContain("Summary: new one");
    expect(fresh).not.toContain("old two");
    const { rows } = await getPool().query(
      `SELECT summary, wake_state, wake_permit_hash IS NULL AS void
       FROM agent_sensor_runs WHERE sensor_id=$1 ORDER BY started_at`,
      [first.sensor_id],
    );
    expect(rows).toEqual([
      { summary: "old one", wake_state: "superseded", void: true },
      { summary: "old two", wake_state: "superseded", void: true },
      { summary: "new one", wake_state: "issued", void: false },
    ]);
    await expect(
      authorizeSensorExecutionLocal(
        owner,
        project_id,
        HOST,
        old.authorization,
        {
          prompt_sha256: sha(old.prompt),
          path: old.path,
          thread_id: old.thread_id,
        },
      ),
    ).rejects.toThrow();
  });

  test("held wakes are marked before they are sent, and held again only if nothing was sent", async () => {
    const active = (
      await approve((await propose({ ...spec, max_wakes_per_day: 10 })).sensor)
    ).sensor;
    const quiet = { exit_code: 0, timed_out: false, stdout: "", stderr: "" };
    host.runAgentSensor
      .mockResolvedValueOnce({
        ...quiet,
        stdout: '{"wake": true, "summary": "first"}\n',
      })
      .mockResolvedValueOnce({
        ...quiet,
        stdout: '{"wake": true, "summary": "held"}\n',
      })
      .mockResolvedValue(quiet);
    await makeDue(active.sensor_id);
    await runDue();
    await makeDue(active.sensor_id);
    await runDue();
    await startTurns();
    const heldState = async () =>
      (
        await getPool().query(
          "SELECT wake_state FROM agent_sensor_runs WHERE sensor_id=$1 AND summary='held'",
          [active.sensor_id],
        )
      ).rows[0].wake_state;
    // Durably taken before the host is asked, so even if recording the
    // outcome failed, no later run could choose it again.
    let during: string | undefined;
    host.deliverAgentSensorWake.mockImplementationOnce(async () => {
      during = await heldState();
      return { not_sent: "the agent's thread is unavailable" };
    });
    await makeDue(active.sensor_id);
    await runDue();
    expect(during).toBe("combining");
    // Certainly not sent: held for the next wake.
    expect(await heldState()).toBe("deferred");
    await makeDue(active.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake.mock.calls.at(-1)[0].prompt).toContain(
      "Summary: held",
    );
    expect(await heldState()).toBe("combined");
  });

  test("wakes held while an earlier one waits arrive together in the next", async () => {
    const active = (
      await approve((await propose({ ...spec, max_wakes_per_day: 10 })).sensor)
    ).sensor;
    const woke = (summary: string, n: number) => ({
      exit_code: 0,
      timed_out: false,
      stdout: `${JSON.stringify({ wake: true, summary, data: { n } })}\n`,
      stderr: "",
    });
    host.runAgentSensor
      .mockResolvedValueOnce(woke("issue 1", 1))
      .mockResolvedValueOnce(woke("issue 2", 2))
      .mockResolvedValueOnce(woke("issue 3", 3))
      .mockResolvedValueOnce({
        exit_code: 0,
        timed_out: false,
        stdout: "",
        stderr: "",
      });
    const outcomes = async () =>
      (
        (await sensorControlLocal(owner, project_id, {
          op: "list",
          sensor_id: active.sensor_id,
        })) as any
      ).runs.map((r: any) => r.outcome);
    for (let i = 0; i < 3; i++) {
      await makeDue(active.sensor_id);
      await runDue();
    }
    // The first wake's turn has not started yet, so the next two are held.
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(1);
    expect(await outcomes()).toEqual([
      "wake-coalesced",
      "wake-coalesced",
      "wake",
    ]);
    // The agent's turn starts; even a quiet run then delivers what was held.
    await getPool().query(
      "UPDATE agent_sensor_runs SET wake_state='consumed' WHERE sensor_id=$1 AND wake_state='issued'",
      [active.sensor_id],
    );
    await makeDue(active.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(2);
    const prompt = host.deliverAgentSensorWake.mock.calls[1][0].prompt;
    expect(prompt).toContain("Summary: 2 events: issue 2 | issue 3");
    expect(prompt).toContain('"n": 3');
    const { rows } = await getPool().query(
      `SELECT wake_state, count(*)::int AS n FROM agent_sensor_runs
       WHERE sensor_id=$1 GROUP BY wake_state ORDER BY wake_state`,
      [active.sensor_id],
    );
    expect(rows).toEqual([
      { wake_state: "combined", n: 2 },
      { wake_state: "consumed", n: 1 },
      { wake_state: "issued", n: 1 },
    ]);
    // Nothing is delivered twice.
    await getPool().query(
      "UPDATE agent_sensor_runs SET wake_state='consumed' WHERE sensor_id=$1 AND wake_state='issued'",
      [active.sensor_id],
    );
    await makeDue(active.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(3);
    expect(host.deliverAgentSensorWake.mock.calls[2][0].prompt).toContain(
      "Summary: 1 new issue",
    );
  });

  test("a script sensor pauses when the project's software changes", async () => {
    const active = (await approve((await propose()).sensor)).sensor;
    await getPool().query(
      "UPDATE projects SET rootfs_image='other:2' WHERE project_id=$1",
      [project_id],
    );
    await makeDue(active.sensor_id);
    await runDue();
    expect(host.runAgentSensor).not.toHaveBeenCalled();
    let { sensors } = (await sensorControlLocal(owner, project_id, {
      op: "list",
    })) as any;
    expect(sensors[0].pause_reason).toMatch(/software/);
    // Resuming approves it for the new software.
    await sensorControlLocal(owner, project_id, {
      op: "resume",
      sensor_id: active.sensor_id,
      revision: sensors[0].revision,
    });
    await makeDue(active.sensor_id);
    await runDue();
    expect(host.runAgentSensor).toHaveBeenCalledTimes(1);
    ({ sensors } = (await sensorControlLocal(owner, project_id, {
      op: "list",
    })) as any);
    expect(sensors[0].status).toBe("active");
  });

  test("Run now starts a run right away, not at the next poll", async () => {
    const { sensor } = await propose();
    const active = (await approve(sensor)).sensor;
    // Polling hourly: only the kick from Run now can start this run.
    const stop = startSensorScheduler(60 * 60_000);
    try {
      await sensorControlLocal(owner, project_id, {
        op: "run",
        sensor_id: active.sensor_id,
        revision: active.revision,
      });
      let runs: any[] = [];
      for (let i = 0; i < 100; i++) {
        runs = (
          await getPool().query(
            "SELECT outcome, manual FROM agent_sensor_runs WHERE sensor_id=$1",
            [active.sensor_id],
          )
        ).rows;
        if (runs[0]?.outcome) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(runs).toEqual([{ outcome: "wake", manual: true }]);
    } finally {
      stop();
    }
  });

  test("agents can read their sensor's run log", async () => {
    const { sensor } = await propose();
    const active = (await approve(sensor)).sensor;
    host.runAgentSensor.mockResolvedValue({
      exit_code: 1,
      timed_out: false,
      stdout: "",
      stderr: "connection refused",
    });
    await makeDue(active.sensor_id);
    await runDue();
    const shown = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "show",
      sensor_id: active.sensor_id,
    })) as any;
    expect(shown.runs[0]).toMatchObject({ outcome: "failed", exit_code: 1 });
    expect(shown.runs[0].output).toContain("connection refused");
  });

  test("a person's scheduled prompt is a normal turn on a schedule", async () => {
    const created = (await sensorControlLocal(owner, project_id, {
      op: "create-prompt",
      agent_id,
      spec: {
        kind: "prompt",
        title: "Morning briefing",
        prompt: "Summarize today's calendar and open PRs.",
        schedule: { kind: "daily", times: ["07:00"], timezone: "UTC" },
      },
    })) as any;
    expect(created.sensor).toMatchObject({
      status: "active",
      approved_by: owner,
    });
    await makeDue(created.sensor.sensor_id);
    await runDue();
    expect(host.runAgentSensor).not.toHaveBeenCalled();
    const delivery = host.deliverAgentSensorWake.mock.calls[0][0];
    expect(delivery.prompt).toMatch(/^\[Scheduled prompt\] "Morning briefing"/);
    expect(delivery.prompt).toContain("Summarize today's calendar");
    // While that turn waits, the next scheduled one is skipped, not stacked.
    await makeDue(created.sensor.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(1);
    const { runs } = (await sensorControlLocal(owner, project_id, {
      op: "list",
      sensor_id: created.sensor.sensor_id,
    })) as any;
    expect(runs[0]).toMatchObject({
      outcome: "wake-coalesced",
      summary: expect.stringMatching(/previous scheduled turn/),
    });
    // Agents propose prompts like scripts; people create them directly.
    await expect(
      sensorControlLocal(owner, project_id, {
        op: "create-prompt",
        agent_id,
        spec,
      }),
    ).rejects.toThrow(/scheduled prompts/);
  });

  test("a CI watcher needs no approval, fires once, and stays authorizable", async () => {
    const watched = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "ci", repo: "sagemathinc/cocalc-ai", pr: 992 },
    })) as any;
    expect(watched.sensor).toMatchObject({
      status: "active",
      approved_by: owner,
    });
    host.runAgentSensor.mockResolvedValueOnce({
      exit_code: 0,
      timed_out: false,
      stdout: "",
      stderr: "",
    });
    await makeDue(watched.sensor.sensor_id);
    await runDue();
    expect(lease.issued[0].uses).toEqual(["github"]);
    expect(host.runAgentSensor.mock.calls[0][0]).toMatchObject({
      language: "python",
      script: expect.stringContaining("gh"),
    });
    expect(host.deliverAgentSensorWake).not.toHaveBeenCalled();
    // Second check: CI finished.
    await makeDue(watched.sensor.sensor_id);
    await runDue();
    const { authorization, prompt, path, thread_id } =
      host.deliverAgentSensorWake.mock.calls[0][0];
    // Done: never runs again, but its queued wake is still authorized.
    expect(await runDue()).toBe(0);
    expect(host.runAgentSensor).toHaveBeenCalledTimes(2);
    // ...and says so: an agent sees it as done, not active.
    const shown = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "show",
      sensor_id: watched.sensor.sensor_id,
    })) as any;
    expect(shown.sensor).toMatchObject({
      status: "done",
      next_run_at: null,
      last_outcome: "wake",
    });
    const listed = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "list",
    })) as any;
    expect(
      listed.sensors.find((s: any) => s.sensor_id === watched.sensor.sensor_id)
        ?.status,
    ).toBe("done");
    // It cannot be paused into a misleading state.
    await expect(
      agentSensorRequest(run, agent, {
        action: "sensor",
        op: "pause",
        sensor_id: watched.sensor.sensor_id,
      }),
    ).rejects.toThrow(/done watcher/);
    await expect(
      authorizeSensorExecutionLocal(owner, project_id, HOST, authorization, {
        prompt_sha256: sha(prompt),
        path,
        thread_id,
      }),
    ).resolves.toBeUndefined();
  });

  test("a finished watcher is not scheduled again and frees its slot", async () => {
    const make = () =>
      agentSensorRequest(run, agent, {
        action: "sensor",
        op: "watch",
        watch: { type: "file", path: "out.txt" },
      }) as any;
    const first = (await make()).sensor;
    await makeDue(first.sensor_id);
    await runDue();
    const { rows } = await getPool().query(
      "SELECT next_run_at, status FROM agent_sensors WHERE sensor_id=$1",
      [first.sensor_id],
    );
    expect(rows[0]).toMatchObject({ next_run_at: null, status: "active" });
    for (let i = 0; i < 5; i++) await make();
    await expect(make()).rejects.toThrow(/at most 5 watchers may be active/);
  });

  const fileWatch = (r: any = run, a: any = agent) =>
    agentSensorRequest(r, a, {
      action: "sensor",
      op: "watch",
      watch: { type: "file", path: "out.txt" },
    }) as any;

  const secondAgent = async () => {
    const other_id = randomUUID();
    await getPool().query(
      `INSERT INTO agent_identities (agent_id, project_id, path, thread_id, name, created_by)
       VALUES ($1, $2, '/home/user/b.chat', 't2', 'second', $3)`,
      [other_id, project_id, owner],
    );
    const otherAgent = (
      await getPool().query(
        "SELECT * FROM agent_identities WHERE agent_id=$1",
        [other_id],
      )
    ).rows[0];
    return {
      otherAgent,
      otherRun: { ...run, agent_id: other_id, run_id: randomUUID() },
    };
  };

  test("the membership tier sets how many watchers an account may have", async () => {
    limits.sensor_max_active_watchers = 2;
    const first = (await fileWatch()).sensor;
    await fileWatch();
    // The error names the watchers holding the places, and how to free one.
    await expect(fileWatch()).rejects.toThrow(
      new RegExp(
        `at most 2 watchers may be active at once for this account.*Active: ${first.sensor_id} \\(agent ${agent_id}.*cocalc sensor delete`,
      ),
    );
    limits.sensor_max_active_watchers = 0;
    await expect(fileWatch()).rejects.toThrow(/does not include agent sensors/);
    // Reminders are counted apart: still allowed, while the tier has wakes.
    await reminder(30);
    limits.sensor_max_wakes_per_day = 0;
    await expect(reminder(31)).rejects.toThrow(
      /does not include agent sensors/,
    );
  });

  test("a per-agent limit keeps one agent from using all of the account's watchers", async () => {
    limits.sensor_max_active_watchers = 3;
    limits.sensor_max_active_watchers_per_agent = 2;
    await fileWatch();
    await fileWatch();
    await expect(fileWatch()).rejects.toThrow(
      /at most 2 watchers may be active at once for this agent/,
    );
    const { otherAgent, otherRun } = await secondAgent();
    await fileWatch(otherRun, otherAgent);
    // The account limit still holds across agents.
    await expect(fileWatch(otherRun, otherAgent)).rejects.toThrow(
      /at most 3 watchers may be active at once for this account/,
    );
  });

  test("a ci watcher is refused when the agent has no GitHub connector", async () => {
    grants.github = false;
    await expect(
      agentSensorRequest(run, agent, {
        action: "sensor",
        op: "watch",
        watch: { type: "ci", repo: "sagemathinc/cocalc-ai", pr: 992 },
      }),
    ).rejects.toThrow(/GitHub connector.*gh pr checks/);
    const { rows } = await getPool().query(
      "SELECT 1 FROM agent_sensors WHERE agent_id=$1",
      [agent.agent_id],
    );
    expect(rows).toHaveLength(0);
    // Other watchers need no connector.
    await expect(fileWatch()).resolves.toMatchObject({
      sensor: expect.objectContaining({ status: "active" }),
    });
  });

  test("a ci watcher whose connector was turned off gives up and wakes its agent, not the person", async () => {
    limits.sensor_max_active_watchers = 1;
    const ci = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "ci", repo: "sagemathinc/cocalc-ai", pr: 992 },
    })) as any;
    grants.github = false;
    await makeDue(ci.sensor.sensor_id);
    await runDue();
    // Nothing ran with credentials, and nobody is asked to resume it.
    expect(lease.issued).toHaveLength(0);
    expect(paused).toHaveLength(0);
    const delivered = host.deliverAgentSensorWake.mock.calls.map(
      (call: any[]) => call[0],
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].prompt).toMatch(/Gave up: .*needs GitHub/);
    const { rows } = await getPool().query(
      "SELECT status, next_run_at FROM agent_sensors WHERE sensor_id=$1",
      [ci.sensor.sensor_id],
    );
    expect(rows[0]).toMatchObject({ status: "active", next_run_at: null });
    // Done, so its place is free again.
    await expect(fileWatch()).resolves.toMatchObject({
      sensor: expect.objectContaining({ status: "active" }),
    });
  });

  test("a watcher whose connector is lost when its token is issued also gives up, not pauses", async () => {
    limits.sensor_max_active_watchers = 1;
    const ci = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "ci", repo: "sagemathinc/cocalc-ai", pr: 992 },
    })) as any;
    await expect(fileWatch()).rejects.toThrow(/at most 1 watchers/);
    // The grant was still there for the check, but no token came back.
    lease.missing = ["github"];
    await makeDue(ci.sensor.sensor_id);
    await runDue();
    expect(host.runAgentSensor).not.toHaveBeenCalled();
    expect(paused).toHaveLength(0);
    const delivered = host.deliverAgentSensorWake.mock.calls.map(
      (call: any[]) => call[0],
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].prompt).toMatch(/Gave up: .*needs GitHub/);
    const { rows } = await getPool().query(
      "SELECT status, pause_reason, next_run_at FROM agent_sensors WHERE sensor_id=$1",
      [ci.sensor.sensor_id],
    );
    expect(rows[0]).toMatchObject({
      status: "active",
      pause_reason: null,
      next_run_at: null,
    });
    // Done, so its place is free again.
    lease.missing = [];
    await expect(fileWatch()).resolves.toMatchObject({
      sensor: expect.objectContaining({ status: "active" }),
    });
  });

  test("a watcher whose check keeps failing gives up and tells its agent why", async () => {
    limits.sensor_max_active_watchers = 1;
    const ci = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "ci", repo: "sagemathinc/cocalc-ai", pr: 1203 },
    })) as any;
    // As on 2026-10-19: the image's gh had no `pr checks --json`.
    host.runAgentSensor.mockResolvedValue({
      exit_code: 1,
      timed_out: false,
      stdout: "",
      stderr: "unknown flag: --json\n",
    });
    for (let i = 0; i < 4; i++) {
      await makeDue(ci.sensor.sensor_id);
      await runDue();
    }
    // Until the last allowed failure it just tries again.
    expect(host.deliverAgentSensorWake).not.toHaveBeenCalled();
    await makeDue(ci.sensor.sensor_id);
    await runDue();
    const delivered = host.deliverAgentSensorWake.mock.calls.map(
      (call: any[]) => call[0],
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].prompt).toMatch(
      /Gave up: .*failed 5 times in a row\. Last error: The script exited with code 1\./,
    );
    expect(delivered[0].prompt).toContain("unknown flag: --json");
    // Not paused, so nobody is asked to resume what cannot be resumed.
    expect(paused).toHaveLength(0);
    const { rows } = await getPool().query(
      "SELECT status, pause_reason, next_run_at FROM agent_sensors WHERE sensor_id=$1",
      [ci.sensor.sensor_id],
    );
    expect(rows[0]).toMatchObject({
      status: "active",
      pause_reason: null,
      next_run_at: null,
    });
    // Done, so its place is free again.
    await expect(fileWatch()).resolves.toMatchObject({
      sensor: expect.objectContaining({ status: "active" }),
    });
  });

  test("a watcher whose check cannot even run gives up the same way", async () => {
    const ci = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "ci", repo: "sagemathinc/cocalc-ai", pr: 1203 },
    })) as any;
    host.runAgentSensor.mockRejectedValue(
      new Error("container failed to start"),
    );
    for (let i = 0; i < 4; i++) {
      await makeDue(ci.sensor.sensor_id);
      await runDue();
    }
    expect(host.deliverAgentSensorWake).not.toHaveBeenCalled();
    await makeDue(ci.sensor.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(1);
    expect(host.deliverAgentSensorWake.mock.calls[0][0].prompt).toMatch(
      /Gave up: .*failed 5 times in a row\. Last error: .*container failed to start/,
    );
    expect(paused).toHaveLength(0);
    const { rows } = await getPool().query(
      "SELECT status, pause_reason, next_run_at FROM agent_sensors WHERE sensor_id=$1",
      [ci.sensor.sensor_id],
    );
    expect(rows[0]).toMatchObject({
      status: "active",
      pause_reason: null,
      next_run_at: null,
    });
  });

  test.each([
    ["the connector check", () => (grants.fail = "home bay unreachable")],
    ["issuing credentials", () => (lease.fail = "home bay unreachable")],
  ])(
    "a watcher whose setup fails (%s) gives up the same way",
    async (_what, breakIt) => {
      const ci = (await agentSensorRequest(run, agent, {
        action: "sensor",
        op: "watch",
        watch: { type: "ci", repo: "sagemathinc/cocalc-ai", pr: 1203 },
      })) as any;
      breakIt();
      for (let i = 0; i < 4; i++) {
        await makeDue(ci.sensor.sensor_id);
        await runDue();
      }
      expect(host.deliverAgentSensorWake).not.toHaveBeenCalled();
      await makeDue(ci.sensor.sensor_id);
      await runDue();
      expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(1);
      expect(host.deliverAgentSensorWake.mock.calls[0][0].prompt).toMatch(
        /Gave up: .*failed 5 times in a row\. Last error: .*home bay unreachable/,
      );
      expect(paused).toHaveLength(0);
      const { rows } = await getPool().query(
        "SELECT status, pause_reason, next_run_at FROM agent_sensors WHERE sensor_id=$1",
        [ci.sensor.sensor_id],
      );
      expect(rows[0]).toMatchObject({
        status: "active",
        pause_reason: null,
        next_run_at: null,
      });
    },
  );

  test("a give-up wake the host did not send is tried again, not paused", async () => {
    const ci = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "ci", repo: "sagemathinc/cocalc-ai", pr: 1203 },
    })) as any;
    host.runAgentSensor.mockResolvedValue({
      exit_code: 1,
      timed_out: false,
      stdout: "",
      stderr: "unknown flag: --json\n",
    });
    for (let i = 0; i < 4; i++) {
      await makeDue(ci.sensor.sensor_id);
      await runDue();
    }
    host.deliverAgentSensorWake.mockResolvedValueOnce({
      not_sent: "the agent's thread is unavailable",
    });
    await makeDue(ci.sensor.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(1);
    expect(paused).toHaveLength(0);
    const state = async () =>
      (
        await getPool().query(
          "SELECT status, pause_reason, consecutive_failures, next_run_at FROM agent_sensors WHERE sensor_id=$1",
          [ci.sensor.sensor_id],
        )
      ).rows[0];
    // Still waiting, with its failures neither reset nor counted.
    expect(await state()).toMatchObject({
      status: "active",
      pause_reason: null,
      consecutive_failures: 4,
    });
    expect((await state()).next_run_at).not.toBeNull();
    // The next failed check gives up again, and this time it is sent.
    await makeDue(ci.sensor.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(2);
    expect(host.deliverAgentSensorWake.mock.calls[1][0].prompt).toMatch(
      /Gave up: .*failed 5 times in a row/,
    );
    expect(paused).toHaveLength(0);
    expect(await state()).toMatchObject({
      status: "active",
      pause_reason: null,
      next_run_at: null,
    });
  });

  test("a give-up wake whose delivery is ambiguous leaves the watcher done, not paused", async () => {
    const ci = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "ci", repo: "sagemathinc/cocalc-ai", pr: 1203 },
    })) as any;
    host.runAgentSensor.mockResolvedValue({
      exit_code: 1,
      timed_out: false,
      stdout: "",
      stderr: "unknown flag: --json\n",
    });
    for (let i = 0; i < 4; i++) {
      await makeDue(ci.sensor.sensor_id);
      await runDue();
    }
    host.deliverAgentSensorWake.mockRejectedValueOnce(new Error("timeout"));
    await makeDue(ci.sensor.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(1);
    // The turn may be queued, so it is not tried again, and nobody is asked
    // to resume it.
    expect(paused).toHaveLength(0);
    const { rows } = await getPool().query(
      "SELECT status, pause_reason, next_run_at FROM agent_sensors WHERE sensor_id=$1",
      [ci.sensor.sensor_id],
    );
    expect(rows[0]).toMatchObject({
      status: "active",
      pause_reason: null,
      next_run_at: null,
    });
  });

  test("a watcher paused by a person gives back its place", async () => {
    limits.sensor_max_active_watchers = 1;
    const first = (await fileWatch()).sensor;
    await expect(fileWatch()).rejects.toThrow(/at most 1 watchers/);
    await sensorControlLocal(owner, project_id, {
      op: "pause",
      sensor_id: first.sensor_id,
    });
    await expect(fileWatch()).resolves.toMatchObject({
      sensor: expect.objectContaining({ status: "active" }),
    });
  });

  test("a fired watcher whose wake is still queued cannot be deleted out from under it", async () => {
    const watched = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "file", path: "out.txt" },
    })) as any;
    await makeDue(watched.sensor.sensor_id);
    await runDue();
    // The host queued the wake (the agent was busy); its turn has not started.
    const { authorization, prompt, path, thread_id } =
      host.deliverAgentSensorWake.mock.calls[0][0];
    const remove = {
      action: "sensor",
      op: "delete",
      sensor_id: watched.sensor.sensor_id,
    } as const;
    await expect(agentSensorRequest(run, agent, remove)).rejects.toThrow(
      /wake is still queued/,
    );
    await expect(
      sensorControlLocal(owner, project_id, {
        op: "delete",
        sensor_id: watched.sensor.sensor_id,
      }),
    ).rejects.toThrow(/wake is still queued/);
    // So the queued turn can still run.
    await expect(
      authorizeSensorExecutionLocal(owner, project_id, HOST, authorization, {
        prompt_sha256: sha(prompt),
        path,
        thread_id,
      }),
    ).resolves.toBeUndefined();
    // Once it started, deleting the done watcher is fine.
    await expect(agentSensorRequest(run, agent, remove)).resolves.toEqual({
      deleted: watched.sensor.sensor_id,
    });
    await expect(agentSensorRequest(run, agent, remove)).rejects.toThrow(
      /sensor not found/,
    );
  });

  test("a watcher cannot be deleted while it is being run and may be waking the agent", async () => {
    const watched = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "file", path: "out.txt" },
    })) as any;
    const remove = {
      action: "sensor",
      op: "delete",
      sensor_id: watched.sensor.sensor_id,
    } as const;
    await makeDue(watched.sensor.sensor_id);
    let during: unknown;
    // After the last dispatch check, just before the wake is issued.
    setSensorIssueHookForTests(async () => {
      during = await agentSensorRequest(run, agent, remove).catch((err) => err);
    });
    try {
      await runDue();
    } finally {
      setSensorIssueHookForTests(undefined);
    }
    expect(`${during}`).toMatch(/checking right now/);
    // The wake was issued and delivered, and its turn can still start.
    const { authorization, prompt, path, thread_id } =
      host.deliverAgentSensorWake.mock.calls[0][0];
    await expect(
      authorizeSensorExecutionLocal(owner, project_id, HOST, authorization, {
        prompt_sha256: sha(prompt),
        path,
        thread_id,
      }),
    ).resolves.toBeUndefined();
  });

  test("a wake is not sent if its watcher was deleted after the lease ran out", async () => {
    const watched = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "file", path: "out.txt" },
    })) as any;
    await makeDue(watched.sensor.sensor_id);
    setSensorIssueHookForTests(async () => {
      // A run that outlived its lease: the delete is no longer held off.
      await getPool().query(
        "UPDATE agent_sensors SET lease_until=now() - interval '1 minute' WHERE sensor_id=$1",
        [watched.sensor.sensor_id],
      );
      await agentSensorRequest(run, agent, {
        action: "sensor",
        op: "delete",
        sensor_id: watched.sensor.sensor_id,
      });
    });
    try {
      await runDue();
    } finally {
      setSensorIssueHookForTests(undefined);
    }
    expect(host.deliverAgentSensorWake).not.toHaveBeenCalled();
  });

  test("a reminder runs no code and wakes the agent with its own note", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const set = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "at", at, note: "Check that PR 992 merged" },
    })) as any;
    expect(set.sensor.next_run_at).toBe(at);
    await makeDue(set.sensor.sensor_id);
    await runDue();
    expect(host.runAgentSensor).not.toHaveBeenCalled();
    expect(host.deliverAgentSensorWake.mock.calls[0][0].prompt).toMatch(
      /^\[Reminder\] You set this reminder for .*Check that PR 992 merged/,
    );
  });

  const reminder = (days: number, r: any = run, a: any = agent) =>
    agentSensorRequest(r, a, {
      action: "sensor",
      op: "watch",
      watch: {
        type: "at",
        at: new Date(Date.now() + days * 86_400_000).toISOString(),
        note: `in ${days} days`,
      },
    }) as any;

  test("a reminder may be months ahead, and takes no watcher's place", async () => {
    limits.sensor_max_active_watchers = 2;
    await fileWatch();
    await fileWatch();
    // Both watcher places taken: a reminder still fits, 300 days out.
    const far = (await reminder(300)).sensor;
    expect(Date.parse(far.next_run_at)).toBeGreaterThan(
      Date.now() + 299 * 86_400_000,
    );
    await expect(fileWatch()).rejects.toThrow(
      /at most 2 watchers may be active at once for this account/,
    );
    // It is listed (and deletable) like any of the agent's sensors.
    const listed = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "list",
    })) as any;
    expect(listed.sensors.map((sensor: any) => sensor.sensor_id)).toContain(
      far.sensor_id,
    );
    await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "delete",
      sensor_id: far.sensor_id,
    });
  });

  test("reminders have their own cap per agent", async () => {
    // Enough wakes that the daily cap on new watchers is not what stops it.
    limits.sensor_max_wakes_per_day = 100;
    for (let i = 0; i < SENSOR_LIMITS.maxRemindersPerAgent; i++)
      await reminder(30 + i);
    await expect(reminder(200)).rejects.toThrow(
      new RegExp(
        `at most ${SENSOR_LIMITS.maxRemindersPerAgent} reminders may be pending at once for this agent`,
      ),
    );
    // Another agent of the account still may set one.
    const { otherAgent, otherRun } = await secondAgent();
    await reminder(200, otherRun, otherAgent);
  });

  test("a reminder is set even when today's wakes are used up (it fires another day)", async () => {
    limits.sensor_max_wakes_per_day = 2;
    for (let i = 0; i < 2; i++)
      await getPool().query(
        `INSERT INTO agent_sensor_events (event_id, kind, account_id, project_id,
           agent_id, sensor_id) VALUES ($1, 'wake', $2, $3, $4, $1)`,
        [randomUUID(), owner, project_id, agent_id],
      );
    await expect(fileWatch()).rejects.toThrow(/used all 2 wakes/);
    await reminder(10);
  });

  test("an expired watcher says so once", async () => {
    const set = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "file", path: "never.txt" },
      hours: 1,
    })) as any;
    await getPool().query(
      "UPDATE agent_sensors SET spec=jsonb_set(spec, '{expires_at}', to_jsonb(now()::text)), script_hash=NULL WHERE sensor_id=$1",
      [set.sensor.sensor_id],
    );
    // The stored spec changed, so its integrity check fails: that is the
    // point of the hash. Recompute it as the server would for a real expiry.
    const { rows } = await getPool().query(
      "SELECT spec FROM agent_sensors WHERE sensor_id=$1",
      [set.sensor.sensor_id],
    );
    const { sensorSpecHash } = await import("./sensors");
    await getPool().query(
      "UPDATE agent_sensors SET script_hash=$2 WHERE sensor_id=$1",
      [set.sensor.sensor_id, sensorSpecHash(rows[0].spec)],
    );
    await makeDue(set.sensor.sensor_id);
    await runDue();
    expect(host.runAgentSensor).not.toHaveBeenCalled();
    expect(host.deliverAgentSensorWake.mock.calls[0][0].prompt).toContain(
      "Gave up",
    );
  });

  test("verify-run accepts only a live, leased run of an active sensor", async () => {
    const active = (await approve((await propose()).sensor)).sensor;
    let liveRun: string | undefined;
    let verdict: unknown;
    host.runAgentSensor.mockImplementation(async (req: any) => {
      liveRun = req.run_id;
      verdict = await sensorControlLocal(owner, project_id, {
        op: "verify-run",
        agent_id,
        run_id: req.run_id,
      });
      return { exit_code: 0, timed_out: false, stdout: "", stderr: "" };
    });
    await makeDue(active.sensor_id);
    await runDue();
    expect(verdict).toEqual({ live: true });
    // After the run, or as someone else, it is not live.
    await expect(
      sensorControlLocal(owner, project_id, {
        op: "verify-run",
        agent_id,
        run_id: liveRun!,
      }),
    ).rejects.toThrow(/not live/);
  });

  test("a membership downgrade pauses sensors that no longer fit", async () => {
    const first = (await approve((await propose()).sensor)).sensor;
    const second = (
      await approve((await propose({ ...spec, title: "Second" })).sensor)
    ).sensor;
    limits.acp_max_active_automations_per_project = 1;
    await makeDue(first.sensor_id);
    await makeDue(second.sensor_id);
    await runDue();
    let { sensors } = (await sensorControlLocal(owner, project_id, {
      op: "list",
    })) as any;
    const byTitle = Object.fromEntries(
      sensors.map((s: any) => [s.spec.title, s]),
    );
    expect(byTitle[spec.title].status).toBe("active");
    expect(byTitle.Second.status).toBe("paused");
    expect(byTitle.Second.pause_reason).toMatch(/more active sensors/);
    limits.sensor_min_interval_minutes = 60;
    await makeDue(first.sensor_id);
    await runDue();
    ({ sensors } = (await sensorControlLocal(owner, project_id, {
      op: "list",
      sensor_id: first.sensor_id,
    })) as any);
    expect(sensors[0].status).toBe("paused");
    expect(sensors[0].pause_reason).toMatch(/no longer fits/);
  });

  test("concurrent approvals cannot exceed the active limit", async () => {
    limits.acp_max_active_automations_per_project = 2;
    const proposed = [];
    for (const title of ["a", "b", "c", "d"])
      proposed.push((await propose({ ...spec, title })).sensor);
    const results = await Promise.allSettled(proposed.map((s) => approve(s)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const { sensors } = (await sensorControlLocal(owner, project_id, {
      op: "list",
    })) as any;
    expect(sensors.filter((s: any) => s.status === "active")).toHaveLength(2);
  });

  test("a sensor-woken chain is bounded by the account's daily budget", async () => {
    limits.sensor_max_wakes_per_day = 3;
    const watch = () =>
      agentSensorRequest(run, agent, {
        action: "sensor",
        op: "watch",
        watch: { type: "file", path: "out.txt" },
      }) as any;
    // Each woken turn sets its successor; finishing or deleting watchers
    // does not give the budget back.
    for (let i = 0; i < 3; i++) {
      const { sensor } = await watch();
      await makeDue(sensor.sensor_id);
      await runDue();
      // The woken turn starts (consuming its wake), then cleans up.
      const { authorization, prompt, path, thread_id } =
        host.deliverAgentSensorWake.mock.calls[i][0];
      await authorizeSensorExecutionLocal(
        owner,
        project_id,
        HOST,
        authorization,
        {
          prompt_sha256: sha(prompt),
          path,
          thread_id,
        },
      );
      await agentSensorRequest(run, agent, {
        action: "sensor",
        op: "delete",
        sensor_id: sensor.sensor_id,
      });
    }
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(3);
    // The wakes are spent: a new watcher could never wake the agent.
    await expect(watch()).rejects.toThrow(/used all 3 wakes/);
  });

  test("watchers that never fire do not use the wake budget; churn is capped", async () => {
    limits.sensor_max_wakes_per_day = 2;
    const watch = () =>
      agentSensorRequest(run, agent, {
        action: "sensor",
        op: "watch",
        watch: { type: "file", path: "out.txt" },
      }) as any;
    // Set and deleted before firing: once the cap was the wake budget (2).
    for (let i = 0; i < 2 * WATCHERS_PER_WAKE; i++) {
      const { sensor } = await watch();
      await agentSensorRequest(run, agent, {
        action: "sensor",
        op: "delete",
        sensor_id: sensor.sensor_id,
      });
    }
    expect(host.deliverAgentSensorWake).not.toHaveBeenCalled();
    await expect(watch()).rejects.toThrow(
      new RegExp(`at most ${2 * WATCHERS_PER_WAKE} watchers a day`),
    );
  });

  test("wakes are limited per account across sensors, and deleting one does not reset it", async () => {
    limits.sensor_max_wakes_per_day = 2;
    const a = (await approve((await propose({ ...spec, title: "A" })).sensor))
      .sensor;
    const b = (await approve((await propose({ ...spec, title: "B" })).sensor))
      .sensor;
    await makeDue(a.sensor_id);
    await runDue();
    await sensorControlLocal(owner, project_id, {
      op: "delete",
      sensor_id: a.sensor_id,
    });
    await makeDue(b.sensor_id);
    await runDue();
    await startTurns();
    await makeDue(b.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(2);
    const { runs } = (await sensorControlLocal(owner, project_id, {
      op: "list",
      sensor_id: b.sensor_id,
    })) as any;
    expect(runs[0].outcome).toBe("wake-limited");
  });

  test("an ambiguous delivery stays counted, and a watcher does not retry it", async () => {
    limits.sensor_max_wakes_per_day = 2;
    const set = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "file", path: "out.txt" },
    })) as any;
    // The acknowledgement is lost: the turn may well be queued.
    host.deliverAgentSensorWake.mockRejectedValueOnce(
      new Error("timeout waiting for the host"),
    );
    await makeDue(set.sensor.sensor_id);
    await runDue();
    const { rows } = await getPool().query(
      `SELECT s.next_run_at, r.outcome, r.error, r.wake_state
       FROM agent_sensors s JOIN agent_sensor_runs r USING (sensor_id)
       WHERE s.sensor_id=$1`,
      [set.sensor.sensor_id],
    );
    expect(rows[0]).toMatchObject({
      next_run_at: null,
      outcome: "wake-failed",
      // Its permit can still start that one turn.
      wake_state: "issued",
    });
    expect(rows[0].error).toMatch(/may not have started.*will not try again/);
    expect(await runDue()).toBe(0);
    // Counted: one wake left in the budget, and the watcher is released.
    const { rows: events } = await getPool().query(
      `SELECT kind, released_at FROM agent_sensor_events WHERE account_id=$1
       ORDER BY kind`,
      [owner],
    );
    expect(events.map((e) => e.kind)).toEqual(["wake", "watch"]);
    expect(events[1].released_at).not.toBeNull();
    const active = (await approve((await propose()).sensor)).sensor;
    host.deliverAgentSensorWake.mockRejectedValueOnce(new Error("lost"));
    await makeDue(active.sensor_id);
    await runDue();
    // A script keeps its schedule; its next wake is held behind the one
    // that may be queued, and once that turn has started, it finds the
    // budget used up.
    await makeDue(active.sensor_id);
    await runDue();
    await startTurns();
    await makeDue(active.sensor_id);
    await runDue();
    const { runs } = (await sensorControlLocal(owner, project_id, {
      op: "list",
      sensor_id: active.sensor_id,
    })) as any;
    expect(runs.map((r: any) => r.outcome)).toEqual([
      "wake-limited",
      "wake-coalesced",
      "wake-failed",
    ]);
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(2);
  });

  test("a watcher is released only once its own bay recorded it as done", async () => {
    const watch = () =>
      agentSensorRequest(run, agent, {
        action: "sensor",
        op: "watch",
        watch: { type: "file", path: "out.txt" },
      }) as any;
    const released = async (sensor_id: string) =>
      (
        await getPool().query(
          "SELECT released_at FROM agent_sensor_events WHERE event_id=$1",
          [sensor_id],
        )
      ).rows[0].released_at != null;
    const lost = (await watch()).sensor;
    // The project bay cannot record the result under this run's lease.
    host.deliverAgentSensorWake.mockImplementationOnce(async () => {
      await getPool().query(
        "UPDATE agent_sensors SET lease_id=gen_random_uuid() WHERE sensor_id=$1",
        [lost.sensor_id],
      );
      return { message_id: "m" };
    });
    await makeDue(lost.sensor_id);
    await runDue();
    expect(await released(lost.sensor_id)).toBe(false);
    const done = (await watch()).sensor;
    await makeDue(done.sensor_id);
    await runDue();
    expect(await released(done.sensor_id)).toBe(true);
    // Done is final: people can neither run, pause nor resume a watcher.
    for (const op of ["run", "pause"] as const)
      await expect(
        sensorControlLocal(owner, project_id, {
          op,
          sensor_id: done.sensor_id,
        }),
      ).rejects.toThrow(/watcher is done/);
    await expect(
      sensorControlLocal(owner, project_id, {
        op: "resume",
        sensor_id: done.sensor_id,
      }),
    ).rejects.toThrow(/resumed/);
    // The scheduler finishing it between a person's checks and the pause
    // (with the same revision) still leaves it done, and its wake valid.
    const racing = (await watch()).sensor;
    setSensorManageHookForTests(async () => {
      await getPool().query(
        "UPDATE agent_sensors SET next_run_at=NULL WHERE sensor_id=$1",
        [racing.sensor_id],
      );
    });
    try {
      await expect(
        sensorControlLocal(owner, project_id, {
          op: "pause",
          sensor_id: racing.sensor_id,
        }),
      ).rejects.toThrow(/changed/);
    } finally {
      setSensorManageHookForTests(undefined);
    }
    const { rows: raced } = await getPool().query(
      "SELECT status FROM agent_sensors WHERE sensor_id=$1",
      [racing.sensor_id],
    );
    expect(raced[0].status).toBe("active");
    // A watcher paused before it fired cannot be resumed either.
    const paused = (await watch()).sensor;
    await sensorControlLocal(owner, project_id, {
      op: "pause",
      sensor_id: paused.sensor_id,
    });
    await expect(
      sensorControlLocal(owner, project_id, {
        op: "resume",
        sensor_id: paused.sensor_id,
      }),
    ).rejects.toThrow(/cannot be resumed/);
  });

  test("a wake the host certainly did not send is voided and given back", async () => {
    limits.sensor_max_wakes_per_day = 1;
    const set = (await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "watch",
      watch: { type: "file", path: "out.txt" },
    })) as any;
    host.deliverAgentSensorWake.mockResolvedValueOnce({
      not_sent: "the agent's thread is unavailable",
    });
    await makeDue(set.sensor.sensor_id);
    await runDue();
    const first = host.deliverAgentSensorWake.mock.calls[0][0];
    const { rows } = await getPool().query(
      "SELECT wake_state, wake_permit_hash FROM agent_sensor_runs WHERE run_id=$1",
      [first.authorization.run_id],
    );
    expect(rows[0]).toEqual({ wake_state: "not-sent", wake_permit_hash: null });
    // Its permit is void, even if the message turned up after all.
    await expect(
      authorizeSensorExecutionLocal(
        owner,
        project_id,
        HOST,
        first.authorization,
        {
          prompt_sha256: sha(first.prompt),
          path: first.path,
          thread_id: first.thread_id,
        },
      ),
    ).rejects.toThrow();
    // The watcher tries again, and the wake it gave back is available.
    await makeDue(set.sensor.sensor_id);
    await runDue();
    expect(host.deliverAgentSensorWake).toHaveBeenCalledTimes(2);
    const { rows: done } = await getPool().query(
      "SELECT next_run_at, last_outcome FROM agent_sensors WHERE sensor_id=$1",
      [set.sensor.sensor_id],
    );
    expect(done[0]).toMatchObject({ next_run_at: null, last_outcome: "wake" });
  });

  test("watcher limits count the account's watchers in every project, through its home", async () => {
    const otherProject = randomUUID();
    const otherAgentId = randomUUID();
    await getPool().query(
      "INSERT INTO projects (project_id, run_quota, users, host_id, rootfs_image) VALUES ($1, $2, $3, $4, 'img:1')",
      [otherProject, { network: true }, { [owner]: { group: "owner" } }, HOST],
    );
    await getPool().query(
      `INSERT INTO agent_identities (agent_id, project_id, path, thread_id, name, created_by)
       VALUES ($1, $2, '/home/user/b.chat', 't2', 'other', $3)`,
      [otherAgentId, otherProject, owner],
    );
    const otherAgent = (
      await getPool().query(
        "SELECT * FROM agent_identities WHERE agent_id=$1",
        [otherAgentId],
      )
    ).rows[0];
    const otherRun = {
      ...run,
      agent_id: otherAgentId,
      project_id: otherProject,
      run_id: randomUUID(),
    };
    const make = (r: any, a: any) =>
      agentSensorRequest(r, a, {
        action: "sensor",
        op: "watch",
        watch: { type: "file", path: "out.txt" },
      }) as any;
    for (let i = 0; i < 3; i++) await make(run, agent);
    const last = (await make(otherRun, otherAgent)).sensor;
    await make(otherRun, otherAgent);
    await expect(make(otherRun, otherAgent)).rejects.toThrow(
      /at most 5 watchers may be active/,
    );
    expect(budget.calls.filter((c) => c.startsWith("reserveWatcher"))).toEqual(
      Array(6).fill(`reserveWatcher:${owner}`),
    );
    // A lost release keeps the watcher counted (until it expires).
    budget.failRelease = true;
    await agentSensorRequest(otherRun, otherAgent, {
      action: "sensor",
      op: "delete",
      sensor_id: last.sensor_id,
    });
    await expect(make(run, agent)).rejects.toThrow(/at most 5 watchers/);
    budget.failRelease = false;
    await sensorControlLocal(owner, otherProject, {
      op: "delete",
      sensor_id: (
        await getPool().query(
          "SELECT sensor_id FROM agent_sensors WHERE project_id=$1",
          [otherProject],
        )
      ).rows[0].sensor_id,
    });
    await expect(make(run, agent)).resolves.toBeTruthy();
  });

  test("code in a sensor run cannot set up sensors", async () => {
    const active = (await approve((await propose()).sensor)).sensor;
    await makeDue(active.sensor_id);
    await runDue();
    const sensorRunId = lease.issued[0].run_id;
    const sensorRun = { ...run, run_id: sensorRunId };
    await expect(
      agentSensorRequest(sensorRun, agent, {
        action: "sensor",
        op: "watch",
        watch: { type: "file", path: "x" },
      }),
    ).rejects.toThrow(/sensor run cannot set up sensors/);
    await expect(
      agentSensorRequest(sensorRun, agent, {
        action: "sensor",
        op: "propose",
        spec,
      }),
    ).rejects.toThrow(/sensor run cannot set up sensors/);
  });

  test.each([
    [
      "paused",
      (id: string) =>
        getPool().query(
          "UPDATE agent_sensors SET status='paused' WHERE sensor_id=$1",
          [id],
        ),
      undefined,
    ],
    [
      "approved again",
      (id: string) =>
        getPool().query(
          "UPDATE agent_sensors SET approved_at=now() + interval '1 second' WHERE sensor_id=$1",
          [id],
        ),
      undefined,
    ],
    [
      "running in changed software",
      () =>
        getPool().query(
          "UPDATE projects SET rootfs_image='other:9' WHERE project_id=$1",
          [project_id],
        ),
      /software/,
    ],
  ])(
    "nothing runs if the sensor is %s right before dispatch",
    async (_label, change, reason) => {
      const active = (await approve((await propose()).sensor)).sensor;
      await makeDue(active.sensor_id);
      setSensorDispatchHookForTests(async () => {
        await change(active.sensor_id);
      });
      try {
        await runDue();
      } finally {
        setSensorDispatchHookForTests(undefined);
      }
      expect(host.runAgentSensor).not.toHaveBeenCalled();
      expect(lease.released).toBe(1);
      if (reason) {
        const { sensors } = (await sensorControlLocal(owner, project_id, {
          op: "list",
        })) as any;
        expect(sensors[0].status).toBe("paused");
        expect(sensors[0].pause_reason).toMatch(reason);
      }
    },
  );

  test("verify-run refuses a run that started before the current approval", async () => {
    const active = (await approve((await propose()).sensor)).sensor;
    let verdict: unknown;
    host.runAgentSensor.mockImplementation(async (req: any) => {
      await getPool().query(
        "UPDATE agent_sensors SET approved_at=now() + interval '1 second' WHERE sensor_id=$1",
        [active.sensor_id],
      );
      verdict = await sensorControlLocal(owner, project_id, {
        op: "verify-run",
        agent_id,
        run_id: req.run_id,
      }).catch((err) => err.message);
      return { exit_code: 0, timed_out: false, stdout: "", stderr: "" };
    });
    await makeDue(active.sensor_id);
    await runDue();
    expect(verdict).toMatch(/not live/);
  });

  test("agents see and manage only their own sensors", async () => {
    const { sensor } = await propose();
    const otherAgent = { ...agent, agent_id: randomUUID() };
    await expect(
      agentSensorRequest(run, otherAgent, {
        action: "sensor",
        op: "show",
        sensor_id: sensor.sensor_id,
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      agentSensorRequest(run, otherAgent, {
        action: "sensor",
        op: "delete",
        sensor_id: sensor.sensor_id,
      }),
    ).rejects.toThrow(/not found/);
    expect(
      (
        (await agentSensorRequest(run, agent, {
          action: "sensor",
          op: "list",
        })) as any
      ).sensors,
    ).toHaveLength(1);
  });
});
