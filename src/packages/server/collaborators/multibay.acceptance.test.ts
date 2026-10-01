/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { MultibayAcceptance } from "./acceptance/harness";

// Opt in explicitly: creates/stops its OWN PG cluster, never inherited PGHOST.
const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;
acceptance("isolated owner/home/host collaboration acceptance", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => {
    const footprint = env?.footprint();
    await env?.close();
    if (footprint?.directory)
      await expect(access(footprint.directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
  }, 60000);

  test("two authenticated humans send from stopped compute, keep private state, revoke and rejoin across independent homes", async () => {
    const { project: project_id, accounts } = env;
    const rooms = await Promise.all([
      env.hub("a", "ensureRoom", { project_id, request_id: randomUUID() }),
      env.hub("b", "ensureRoom", { project_id, request_id: randomUUID() }),
    ]);
    expect(rooms[0].room_id).toBe(rooms[1].room_id);
    await env.send("a", "initialize", { request_id: randomUUID() });
    const thread = await env.send("a", "createThread", {
      request_id: randomUUID(),
      title: "Acceptance discussion",
    });
    const target = {
      project_id,
      kind: "conversation",
      resource_id: thread.thread_id,
    };
    await env.converge(
      async () => (await env.hub("b", "listResources")).items.length === 1,
    );
    const before = await env.hub("b", "listResources");
    for (const role of ["a", "b"] as const)
      await env.hub(role, "setPersonalState", {
        ...target,
        patch: { following: true, alias: `${role}-private`, collected: true },
      });

    // Principal binding must come from the socket, not a forged payload/subject.
    await expect(
      env.hub("a", "registerSource", {
        project_id,
        host_id: env.host,
        chat_path: rooms[0].chat_path,
      }),
    ).rejects.toThrow(/principal|host/);
    await expect(
      env.worker("a").call("hub", {
        account_id: accounts[1],
        name: "collaborators.listResources",
        opts: {},
      }),
    ).rejects.toThrow(/403|permission|denied|allowed|authorized/);
    await expect(
      env.send("a", "initialize", { request_id: randomUUID() }, accounts[1]),
    ).rejects.toThrow(/403|permission|denied|allowed|authorized/);
    await expect(
      env.worker("a").call("raw", {
        subject: `bay.${env.bays[0]}.rpc.collaborators.v1`,
        data: { name: "ownedResource", args: [target] },
      }),
    ).rejects.toThrow(/403|permission|denied|allowed|authorized/);
    const forged = await env.hub("a", "listResources", {
      account_id: accounts[1],
    });
    expect(forged.items[0].personal.alias).toBe("a-private");

    const operation = randomUUID();
    const messages = await Promise.all([
      env.retrySend("a", "send", {
        request_id: operation,
        thread_id: thread.thread_id,
        text: "private body from Alice",
      }),
      env.retrySend("b", "send", {
        request_id: operation,
        thread_id: thread.thread_id,
        text: "private body from Bob",
      }),
    ]);
    expect(messages[0].message_id).not.toBe(messages[1].message_id);
    const repeat = await env.retrySend("a", "send", {
      request_id: operation,
      thread_id: thread.thread_id,
      text: "private body from Alice",
    });
    expect(repeat.message_id).toBe(messages[0].message_id);
    await env.converge(async () => {
      const page = await env.hub("b", "listResources");
      return (
        Number(page.items[0]?.activity) >= 2 &&
        (
          await env.sql(
            "b",
            "SELECT count(*) AS n FROM notification_targets WHERE target_account_id=$1",
            [accounts[1]],
          )
        )[0].n === "1"
      );
    });
    const host = await env.worker("host").call("inspect");
    const chats = host.rows
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line))
      .filter((row: any) => row.event === "chat");
    expect(chats).toHaveLength(2);
    expect(new Set(chats.map((row: any) => row.sender_id))).toEqual(
      new Set(accounts),
    );
    expect(host.project.state).toBe("opened");
    expect(
      (await env.hub("b", "check", { since: before.revision })).reset,
    ).toBe(true);
    expect(
      JSON.stringify((await env.hub("b", "listResources")).items),
    ).not.toContain("private body");
    for (const role of ["a", "b"] as const) {
      expect(
        (await env.sql(role, "SELECT alias FROM collaboration_personal"))[0]
          .alias,
      ).toBe(`${role}-private`);
      expect(await env.sql(role, "SELECT project_id FROM projects")).toEqual(
        [],
      );
      expect(
        await env.sql(role, "SELECT project_id FROM collaboration_catalog"),
      ).toEqual([]);
    }
    expect(
      await env.sql("owner", "SELECT account_id FROM collaboration_personal"),
    ).toEqual([]);
    expect(
      await env.sql("owner", "SELECT account_id FROM collaboration_index"),
    ).toEqual([]);

    // Leave home projection AND host users stale; owner membership must win.
    const revision = (await env.hub("b", "listResources")).revision;
    await env.worker("owner").call("membership", { group: "viewer" });
    await expect(env.hub("b", "getResource", target)).rejects.toThrow(
      /access denied/,
    );
    await expect(
      env.send("b", "send", {
        request_id: randomUUID(),
        thread_id: thread.thread_id,
        text: "must not be saved",
      }),
    ).rejects.toThrow(/access denied/);
    await env.converge(
      async () => (await env.hub("b", "listResources")).items.length === 0,
    );
    expect((await env.hub("b", "check", { since: revision })).reset).toBe(true);
    expect((await env.hub("a", "listResources")).items).toHaveLength(1);
    const revokedCount = (
      await env.sql("b", "SELECT count(*) AS n FROM notification_targets")
    )[0].n;
    await env.send("a", "send", {
      request_id: randomUUID(),
      thread_id: thread.thread_id,
      text: "while Bob was revoked",
    });
    await env.converge(
      async () =>
        Number((await env.hub("a", "listResources")).items[0]?.activity) >= 3,
    );
    expect(
      (await env.sql("b", "SELECT count(*) AS n FROM notification_targets"))[0]
        .n,
    ).toBe(revokedCount);
    await env.worker("owner").call("membership", { group: "collaborator" });
    await env.converge(
      async () => (await env.hub("b", "listResources")).items.length === 1,
    );
    expect(
      (await env.sql("b", "SELECT alias FROM collaboration_personal"))[0].alias,
    ).toBe("b-private");
    expect(
      (await env.sql("b", "SELECT count(*) AS n FROM notification_targets"))[0]
        .n,
    ).toBe(revokedCount);
    await env.send("a", "send", {
      request_id: randomUUID(),
      thread_id: thread.thread_id,
      text: "after Bob rejoined",
    });
    await env.converge(
      async () =>
        Number(
          (
            await env.sql("b", "SELECT count(*) AS n FROM notification_targets")
          )[0].n,
        ) > Number(revokedCount),
    );

    const instances = await Promise.all(
      (["owner", "a", "b"] as const).map((role) =>
        env.worker(role).call("inspect"),
      ),
    );
    expect(new Set(instances.map((value) => value.database)).size).toBe(3);
    expect(
      new Set([...env.workers.values()].map((worker) => worker.child.pid)).size,
    ).toBe(4);
    expect(instances.map((value) => value.counters.starts)).toEqual([0, 0, 0]);
    expect(instances[0].counters.ownerCalls.sharedProjectPage).toBeGreaterThan(
      0,
    );
    expect(
      instances[0].counters.ownerCalls.notificationObligation,
    ).toBeGreaterThan(0);
    expect(
      (
        await env.sql(
          "owner",
          "SELECT state FROM projects WHERE project_id=$1",
          [project_id],
        )
      )[0].state.state,
    ).toBe("opened");
  }, 180000);

  test("a persisted send survives a lost acknowledgement, same-ID retries and a host process crash", async () => {
    const project_id = env.project;
    const room = await env.hub("a", "ensureRoom", {
      project_id,
      request_id: randomUUID(),
    });
    await env.retrySend("a", "initialize", { request_id: randomUUID() });
    const thread = await env.retrySend("a", "createThread", {
      request_id: randomUUID(),
      title: "Transport recovery",
    });
    const target = {
      project_id,
      kind: "conversation",
      resource_id: thread.thread_id,
    };
    const resource = async () =>
      (await env.hub("b", "listResources")).items.find(
        (item: any) => item.resource_id === thread.thread_id,
      );
    await env.converge(async () => !!(await resource()));
    await env.hub("b", "setPersonalState", {
      ...target,
      patch: { following: true, alias: "survives-host-crash", collected: true },
    });
    const countNotifications = async () =>
      Number(
        (
          await env.sql(
            "b",
            "SELECT count(*) AS n FROM notification_targets WHERE target_account_id=$1",
            [env.accounts[1]],
          )
        )[0].n,
      );
    const before = await countNotifications();
    const beforeActivity = Number((await resource()).activity);
    const opts = {
      request_id: randomUUID(),
      thread_id: thread.thread_id,
      text: "Persisted before acknowledgement was lost",
    };
    await env
      .worker("host")
      .call("dropSendReply", { request_id: opts.request_id });
    await expect(env.send("a", "send", opts, undefined, 3000)).rejects.toThrow(
      /timeout|timed out/i,
    );
    const persisted = await env.worker("host").call("inspect");
    expect(persisted.droppedReplies).toHaveLength(1);
    const message_id = persisted.droppedReplies[0].result.message_id;
    const chatRows = (rows: string) =>
      rows
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(
          (row: any) =>
            row.event === "chat" && row.thread_id === thread.thread_id,
        );
    expect(chatRows(persisted.rows)).toHaveLength(1);
    expect((await env.retrySend("a", "send", opts)).message_id).toBe(
      message_id,
    );
    await env.converge(
      async () =>
        (await countNotifications()) === before + 1 &&
        Number((await resource())?.activity) > beforeActivity,
    );
    const activity = (await resource()).activity;
    const restart = await env.restartHost();
    expect(restart.newPid).not.toBe(restart.oldPid);
    expect((await env.retrySend("a", "send", opts)).message_id).toBe(
      message_id,
    );
    const recovered = await env.worker("host").call("inspect");
    expect(chatRows(recovered.rows)).toHaveLength(1);
    expect(recovered.project.state).toBe("opened");
    expect(
      await env.hub("b", "ensureRoom", {
        project_id,
        request_id: randomUUID(),
      }),
    ).toMatchObject({ room_id: room.room_id, initialized: true });
    await env.converge(async () => (await resource())?.activity === activity);
    expect(await countNotifications()).toBe(before + 1);
    expect((await resource()).personal).toMatchObject({
      alias: "survives-host-crash",
      collected: true,
      following: true,
    });
    await env.retrySend("a", "send", {
      ...opts,
      request_id: randomUUID(),
      text: "A new send after host recovery",
    });
    await env.converge(
      async () =>
        Number((await resource())?.activity) > Number(activity) &&
        (await countNotifications()) === before + 2,
    );
    expect(
      chatRows((await env.worker("host").call("inspect")).rows),
    ).toHaveLength(2);
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 150000);

  test("private account rehome RPC retries a fenced transfer between independent home databases", async () => {
    const account_id = env.accounts[0];
    await env.hub("a", "ensureRoom", {
      project_id: env.project,
      request_id: randomUUID(),
    });
    const thread = await env.retrySend("a", "createThread", {
      request_id: randomUUID(),
      title: "Home transfer",
    });
    const target = {
      project_id: env.project,
      kind: "conversation",
      resource_id: thread.thread_id,
    };
    const resource = async () =>
      (await env.hub("a", "listResources")).items.find(
        (item: any) => item.resource_id === thread.thread_id,
      );
    await env.converge(async () => !!(await resource()));
    await env.hub("a", "setPersonalState", {
      ...target,
      patch: {
        alias: "portable-private-name",
        collected: true,
        following: true,
      },
    });
    const notificationCount = async (role: "a" | "b") =>
      Number(
        (
          await env.sql(
            role,
            "SELECT count(*) AS n FROM notification_targets WHERE target_account_id=$1",
            [account_id],
          )
        )[0].n,
      );
    const before = await notificationCount("a");
    const send = {
      request_id: randomUUID(),
      thread_id: thread.thread_id,
      text: "Before account cutover",
    };
    await env.retrySend("b", "send", send);
    await env.converge(
      async () => (await notificationCount("a")) === before + 1,
    );
    const activity = (await resource()).activity;
    await env.hub("a", "setPersonalState", {
      ...target,
      patch: { muted: true, read_through: activity },
    });
    const personal = await env.sql(
      "a",
      "SELECT * FROM collaboration_personal WHERE account_id=$1 ORDER BY entry_key",
      [account_id],
    );
    const targets = await env.sql(
      "a",
      "SELECT event_id FROM notification_targets WHERE target_account_id=$1 ORDER BY event_id",
      [account_id],
    );
    const revision = (await env.hub("a", "listResources")).revision;
    await env.worker("b").call("interruptAccountCopy");
    const request = { source_bay_id: env.bays[1], dest_bay_id: env.bays[2] };
    await expect(
      env.worker("owner").call("accountRehome", request),
    ).rejects.toThrow(
      "fixture interrupted account copy after durable page receipt",
    );
    const operation = (
      await env.sql(
        "a",
        "SELECT op_id,status,stage FROM account_rehome_operations WHERE account_id=$1",
        [account_id],
      )
    )[0];
    expect(operation).toMatchObject({
      status: "failed",
      stage: "source_flipped",
    });
    expect(
      (
        await env.sql(
          "a",
          "SELECT state FROM account_collaboration_handoffs WHERE account_id=$1",
          [account_id],
        )
      )[0].state,
    ).toBe("frozen");
    expect(
      (
        await env.sql(
          "b",
          "SELECT state FROM account_collaboration_handoffs WHERE account_id=$1",
          [account_id],
        )
      )[0].state,
    ).toBe("accepted");
    for (const bay_id of [env.bays[1], env.bays[2]])
      await expect(
        env.worker("owner").call("privatePersonalWrite", {
          bay_id,
          opts: {
            ...target,
            account_id,
            patch: { alias: "must not overwrite frozen snapshot" },
          },
        }),
      ).rejects.toThrow(/home|rehome|frozen|authority/i);
    // A human must not be able to invoke the administrative bay protocol.
    await expect(
      env.worker("a").call("raw", {
        subject: `bay.${env.bays[2]}.rpc.account-local.accept-rehome`,
        data: { name: "acceptRehome", args: [{}] },
      }),
    ).rejects.toThrow(/403|permission|denied|allowed|authorized/);
    const result = await env
      .worker("owner")
      .call("accountRehome", { ...request, op_id: operation.op_id });
    expect(result).toMatchObject({
      status: "rehomed",
      operation_status: "succeeded",
      home_bay_id: env.bays[2],
    });
    expect(
      await env.sql(
        "b",
        "SELECT * FROM collaboration_personal WHERE account_id=$1 ORDER BY entry_key",
        [account_id],
      ),
    ).toEqual(personal);

    expect(
      await env.sql(
        "b",
        "SELECT event_id FROM notification_targets WHERE target_account_id=$1 ORDER BY event_id",
        [account_id],
      ),
    ).toEqual(targets);
    expect(
      await env.sql(
        "a",
        "SELECT * FROM collaboration_personal WHERE account_id=$1",
        [account_id],
      ),
    ).toEqual([]);
    expect(
      await env.sql(
        "a",
        "SELECT * FROM notification_targets WHERE target_account_id=$1",
        [account_id],
      ),
    ).toEqual([]);
    expect(
      await env.sql(
        "b",
        "SELECT * FROM collaboration_index WHERE account_id=$1",
        [account_id],
      ),
    ).toEqual([]);
    expect(
      await env.sql(
        "b",
        "SELECT * FROM collaboration_access WHERE account_id=$1 AND lease_until>now()",
        [account_id],
      ),
    ).toEqual([]);
    await expect(
      env.worker("owner").call("privatePersonalWrite", {
        bay_id: env.bays[1],
        opts: { ...target, account_id, patch: { alias: "stale home write" } },
      }),
    ).rejects.toThrow(/home|rehome|authority/i);
    await env.converge(async () => !!(await resource()));
    expect((await resource()).personal).toMatchObject({
      alias: "portable-private-name",
      following: true,
      collected: true,
      muted: true,
      read_through: activity,
    });
    expect((await env.hub("a", "check", { since: revision })).reset).toBe(true);
    await env.retrySend("b", "send", send);
    await env.worker("host").call("tick");
    await env.worker("b").call("tick");
    expect(await notificationCount("b")).toBe(before + 1);
    await env.hub("a", "setPersonalState", {
      ...target,
      patch: { muted: false },
    });
    await env.retrySend("b", "send", {
      ...send,
      request_id: randomUUID(),
      text: "After account cutover",
    });
    await env.converge(
      async () => (await notificationCount("b")) === before + 2,
    );
    const destination = await env.worker("b").call("inspect");
    expect(destination.counters.rehomeCalls.acceptRehome).toBe(1);
    expect(destination.counters.rehomeCalls.copyRehomeState).toBeGreaterThan(2);
    expect(destination.counters.starts).toBe(0);
  }, 150000);

  test("project owner rehome transports the canonical pointer and catalog without moving or starting compute", async () => {
    const project_id = env.project;
    const room = await env.hub("a", "ensureRoom", {
      project_id,
      request_id: randomUUID(),
    });
    const thread = await env.retrySend("a", "createThread", {
      request_id: randomUUID(),
      title: "Owner transfer",
    });
    const target = {
      project_id,
      kind: "conversation",
      resource_id: thread.thread_id,
    };
    const resource = async () =>
      (await env.hub("b", "listResources")).items.find(
        (item: any) => item.resource_id === thread.thread_id,
      );
    await env.converge(async () => !!(await resource()));
    await env.hub("b", "setPersonalState", {
      ...target,
      patch: { alias: "owner-independent-alias", following: true },
    });
    const countNotifications = async () =>
      Number(
        (
          await env.sql(
            "b",
            "SELECT count(*) AS n FROM notification_targets WHERE target_account_id=$1",
            [env.accounts[1]],
          )
        )[0].n,
      );
    const before = await countNotifications();
    const beforeActivity = Number((await resource()).activity);
    const send = {
      request_id: randomUUID(),
      thread_id: thread.thread_id,
      text: "Before owner cutover",
    };
    await env.retrySend("a", "send", send);
    await env.converge(
      async () =>
        (await countNotifications()) === before + 1 &&
        Number((await resource())?.activity) > beforeActivity,
    );
    const activity = (await resource()).activity;
    const catalog = await env.sql(
      "owner",
      "SELECT entry_key,source_id,metadata FROM collaboration_catalog WHERE project_id=$1 ORDER BY entry_key",
      [project_id],
    );
    const hostPid = env.worker("host").child.pid;
    const result = await env.worker("b").call("projectRehome", {
      source_bay_id: env.bays[0],
      dest_bay_id: env.bays[1],
    });
    expect(result).toMatchObject({
      status: "rehomed",
      operation_status: "succeeded",
      owning_bay_id: env.bays[1],
    });
    expect(
      await env.sql(
        "a",
        "SELECT entry_key,source_id,metadata FROM collaboration_catalog WHERE project_id=$1 ORDER BY entry_key",
        [project_id],
      ),
    ).toEqual(catalog);
    // The source retains a frozen catalog, not authority to read or mutate it.
    expect(
      (
        await env.sql(
          "owner",
          "SELECT owning_bay_id FROM projects WHERE project_id=$1",
          [project_id],
        )
      )[0].owning_bay_id,
    ).toBe(env.bays[1]);
    for (const [method, opts] of [
      ["ownedResource", { ...target, account_id: env.accounts[1] }],
      [
        "registerSource",
        { project_id, host_id: env.host, chat_path: room.chat_path },
      ],
    ])
      await expect(
        env.worker("b").call("privateOwnerRequest", {
          bay_id: env.bays[0],
          method,
          opts,
        }),
      ).rejects.toThrow(/owner|owning|authority|routing|bay/i);
    expect(
      (
        await env.sql(
          "a",
          "SELECT host_id,owning_bay_id,state FROM projects WHERE project_id=$1",
          [project_id],
        )
      )[0],
    ).toMatchObject({
      host_id: env.host,
      owning_bay_id: env.bays[1],
      state: { state: "opened" },
    });
    expect(
      await env.hub("b", "ensureRoom", {
        project_id,
        request_id: randomUUID(),
      }),
    ).toMatchObject({
      room_id: room.room_id,
      chat_path: room.chat_path,
      initialized: true,
    });
    expect((await env.hub("b", "getResource", target)).personal.alias).toBe(
      "owner-independent-alias",
    );
    await env.converge(async () => (await resource())?.activity === activity);
    expect(await countNotifications()).toBe(before + 1);
    await env.retrySend("a", "send", send);
    await env.worker("host").call("tick");
    await env.worker("b").call("tick");
    expect(await countNotifications()).toBe(before + 1);
    await env.retrySend("a", "send", {
      ...send,
      request_id: randomUUID(),
      text: "After owner cutover",
    });
    await env.converge(
      async () =>
        Number((await resource())?.activity) > Number(activity) &&
        (await countNotifications()) === before + 2,
    );
    expect(env.worker("host").child.pid).toBe(hostPid);
    const destination = await env.worker("a").call("inspect");
    expect(
      destination.counters.rehomeCalls["project.collaborationRehome.prepare"],
    ).toBe(1);
    expect(
      destination.counters.rehomeCalls["project.collaborationRehome.page"],
    ).toBeGreaterThan(0);
    expect(
      destination.counters.rehomeCalls["project.collaborationRehome.activate"],
    ).toBe(1);
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 150000);

  test("startup failure stops its partially booted processes and private database", async () => {
    const partial = new MultibayAcceptance();
    let directory = "";
    const processes: Array<import("node:child_process").ChildProcess> = [];
    await expect(
      partial.start(() => {
        directory = partial.footprint().directory;
        processes.push(
          ...[...partial.workers.values()].map((worker) => worker.child),
        );
        throw Error("intentional acceptance startup failure");
      }),
    ).rejects.toThrow("intentional acceptance startup failure");
    expect(directory).not.toBe("");
    expect(partial.workers.size).toBe(0);
    expect(processes.length).toBe(1);
    expect(
      processes.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    ).toBe(true);
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await partial.close();
  }, 90000);
});
