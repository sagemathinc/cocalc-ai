import { randomUUID } from "node:crypto";
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

import {
  agentSensorRequest,
  authorizeSensorExecutionLocal,
  sensorControlLocal,
} from "./sensors";
import { claimDueSensors, runClaimedSensor } from "./sensor-scheduler";

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
    });
  });

  beforeEach(async () => {
    access.denied.clear();
    for (const key of Object.keys(limits)) delete limits[key];
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
      "INSERT INTO projects (project_id, run_quota) VALUES ($1, $2)",
      [project_id, { network: true }],
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

  test("execution is authorized only while the sensor is active as approved", async () => {
    const { sensor } = await propose();
    const active = (await approve(sensor)).sensor;
    const authorization = {
      version: 1 as const,
      sensor_id: active.sensor_id,
      project_id,
      agent_id,
      script_hash: active.script_hash,
      run_id: randomUUID(),
    };
    await expect(
      authorizeSensorExecutionLocal(
        owner,
        project_id,
        randomUUID(),
        authorization,
      ),
    ).resolves.toBeUndefined();
    await expect(
      authorizeSensorExecutionLocal(
        randomUUID(),
        project_id,
        randomUUID(),
        authorization,
      ),
    ).rejects.toThrow(/no longer active/);
    await expect(
      authorizeSensorExecutionLocal(owner, project_id, randomUUID(), {
        ...authorization,
        script_hash: "0".repeat(64),
      }),
    ).rejects.toThrow(/no longer active/);
    await agentSensorRequest(run, agent, {
      action: "sensor",
      op: "pause",
      sensor_id: active.sensor_id,
    });
    await expect(
      authorizeSensorExecutionLocal(
        owner,
        project_id,
        randomUUID(),
        authorization,
      ),
    ).rejects.toThrow(/no longer active/);
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
