/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const syncdb = {
  rows: [] as any[],
  get: jest.fn(() => syncdb.rows),
  set: jest.fn(),
  commit: jest.fn(),
  save: jest.fn(async () => {}),
  save_to_disk: jest.fn(async () => {}),
};
const acquire = jest.fn(async () => syncdb);
const release = jest.fn(async () => {});
const admit = jest.fn(async () => ({ state: "queued" }));
const prepare = jest.fn();

jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: (...args: any[]) => (acquire as any)(...args),
  releaseChatSyncDB: (...args: any[]) => (release as any)(...args),
}));
jest.mock("@cocalc/chat/send", () => ({
  prepareChatSend: (opts: any) => (
    prepare(opts),
    {
      message: { message_id: "m1", event: "chat", thread_id: "t1" },
      request: { chat: {} },
    }
  ),
  admitPreparedChatSend: (...args: any[]) => (admit as any)(...args),
}));

import { deliverSensorWake } from "../sensor-wake";

const wake = {
  account_id: "00000000-0000-4000-8000-000000000001",
  path: "/home/user/a.chat",
  thread_id: "t1",
  prompt: "[Sensor wake] ...",
  title: "CI",
  authorization: {
    version: 1,
    sensor_id: "00000000-0000-4000-8000-000000000002",
    project_id: "00000000-0000-4000-8000-000000000003",
    agent_id: "00000000-0000-4000-8000-000000000004",
    script_hash: "h",
    run_id: "00000000-0000-4000-8000-000000000005",
    permit: "p".repeat(43),
  },
} as any;
const running = async () => {};

beforeEach(() => {
  jest.clearAllMocks();
  syncdb.rows = [{ event: "chat-thread-config", thread_id: "t1" }];
});

describe("sensor wake delivery", () => {
  it("delivers a wake as an agent-authored turn", async () => {
    await expect(deliverSensorWake({} as any, wake, running)).resolves.toEqual({
      message_id: "m1",
      effective_delivery: "queued",
    });
    // An older hub sends no delivery: a turn of its own, as before.
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ guidance: false }),
    );
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("as guidance it joins the running turn, and says so", async () => {
    admit.mockResolvedValueOnce({ state: "steered" });
    await expect(
      deliverSensorWake({} as any, { ...wake, delivery: "guidance" }, running),
    ).resolves.toEqual({
      message_id: "m1",
      effective_delivery: "live-guidance",
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ guidance: true }),
    );
    // The message says how it arrived; only its key and that field are set.
    expect(syncdb.set).toHaveBeenLastCalledWith({
      event: "chat",
      message_id: "m1",
      thread_id: "t1",
      sensor_wake: {
        sensor_id: wake.authorization.sensor_id,
        run_id: wake.authorization.run_id,
        title: "CI",
        effective_delivery: "live-guidance",
      },
    });
    // Handed to the worker running the turn: not known yet, so not claimed.
    admit.mockResolvedValueOnce({ state: "steered", pending: true } as any);
    await expect(
      deliverSensorWake({} as any, { ...wake, delivery: "guidance" }, running),
    ).resolves.toEqual({ message_id: "m1" });
    // No running turn to join (or it could not): a turn of its own.
    admit.mockResolvedValueOnce({ state: "queued" });
    await expect(
      deliverSensorWake({} as any, { ...wake, delivery: "guidance" }, running),
    ).resolves.toEqual({ message_id: "m1", effective_delivery: "queued" });
  });

  it("reports not_sent only when nothing was written", async () => {
    // The project did not start.
    await expect(
      deliverSensorWake({} as any, wake, async () => {
        throw new Error("no capacity");
      }),
    ).resolves.toEqual({ not_sent: expect.stringContaining("no capacity") });
    // The chat did not open.
    acquire.mockRejectedValueOnce(new Error("sync timeout"));
    await expect(deliverSensorWake({} as any, wake, running)).resolves.toEqual({
      not_sent: expect.stringContaining("sync timeout"),
    });
    // The thread is gone.
    syncdb.rows = [
      { event: "chat-thread-config", thread_id: "t1", archived: true },
    ];
    await expect(deliverSensorWake({} as any, wake, running)).resolves.toEqual({
      not_sent: "the agent's thread is unavailable",
    });
    expect(syncdb.set).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("throws when the turn may already be queued", async () => {
    admit.mockRejectedValueOnce(new Error("acknowledgement lost"));
    await expect(deliverSensorWake({} as any, wake, running)).rejects.toThrow(
      "acknowledgement lost",
    );
    syncdb.save.mockRejectedValueOnce(new Error("save failed"));
    await expect(deliverSensorWake({} as any, wake, running)).rejects.toThrow(
      "save failed",
    );
    expect(release).toHaveBeenCalledTimes(2);
  });
});
