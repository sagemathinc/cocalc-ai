/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { publishArtifact } from "@cocalc/chat";
import { createLiteArtifactCatalog } from "../artifacts/service";
import { LitePersonalLibrary } from "../artifacts/personal-library";
import { artifactPin } from "./library";
import { createLiteCollaborators } from "./service";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "22222222-2222-4222-8222-222222222222";
const thread_id = "33333333-3333-4333-8333-333333333333";
const message_id = "44444444-4444-4444-8444-444444444444";

function document(title = "A human discussion"): string {
  return [
    {
      event: "chat-thread",
      thread_id,
      created_by: account_id,
      created_at: "2026-01-01T00:00:00Z",
    },
    { event: "chat-thread-config", thread_id, agent_kind: "none", name: title },
    {
      event: "chat",
      thread_id,
      message_id,
      sender_id: account_id,
      date: "2026-01-01T00:00:01Z",
      content: "Message bodies must not become index data",
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
}

test("service consumes a local source index without discovery triggered by API reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-collaborators-service-"));
  const source = join(directory, "existing.chat");
  writeFileSync(source, document());
  const sourcePage = jest.fn(async () => ({ paths: [source] }));
  const runtime = createLiteCollaborators({
    directory: join(directory, "private"),
    path: directory,
    project_id,
    account_id,
    isEnabled: () => true,
    sourcePage,
    agentPins: {
      read: () => [],
      set: () => {
        throw Error("unexpected agent pin write");
      },
    },
  });
  try {
    expect(sourcePage).not.toHaveBeenCalled();
    expect((await runtime.api.listResources({ account_id })).items).toEqual([]);
    expect(sourcePage).not.toHaveBeenCalled();
    await runtime.service.runOnce();
    const page = await runtime.api.listResources({ account_id });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      resource_id: thread_id,
      kind: "conversation",
      chat_path: source,
      activity: 1,
    });
    expect(JSON.stringify(page)).not.toContain("Message bodies");
    expect(page.coverage).toBe("partial");
    await runtime.api.listResources({ account_id });
    expect(sourcePage).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("filesystem journal indexes new unnamed sources, preserves malformed input, and processes deletion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-collaborators-write-"));
  const options = {
    directory: join(directory, "private"),
    path: directory,
    project_id,
    account_id,
    isEnabled: () => true,
    sourcePage: async () => ({ paths: [] }),
    agentPins: {
      read: () => [],
      set: () => {
        throw Error("unexpected agent pin write");
      },
    },
  };
  const runtime = createLiteCollaborators(options);
  const fs = runtime.wrapFilesystem(
    new SandboxedFilesystem(directory, { unsafeMode: true, rootfs: "/" }),
    project_id,
  );
  try {
    await fs.writeFile("new.chat", document());
    await runtime.service.runOnce();
    const request = {
      account_id,
      project_id,
      kind: "conversation" as const,
      resource_id: thread_id,
    };
    const original = await runtime.api.getResource(request);
    expect(original).toMatchObject({
      title: "A human discussion",
      chat_path: join(directory, "new.chat"),
      personal: { collected: false, following: false },
    });
    await fs.writeFile("new.chat", "{invalid json");
    await runtime.service.runOnce();
    expect(await runtime.api.getResource(request)).toEqual(original);
    expect((await runtime.api.listResources({ account_id })).coverage).toBe(
      "partial",
    );
    await fs.unlink("new.chat");
    // Retry backoff must expire before the queued deletion is scanned.
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    await runtime.service.runOnce();
    expect(await runtime.api.getResource(request)).toBeNull();
    expect(() => createLiteCollaborators(options)).toThrow(/locked/);
    runtime.stop();
    expect(() => createLiteCollaborators(options)).toThrow(/locked/);
  } finally {
    jest.restoreAllMocks();
    fs.close();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default-off skips source discovery and queued writes; enabling resumes without a browser scan", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-collaborators-disabled-"));
  let enabled = false;
  let disableDuringDiscovery = false;
  const source = join(directory, "indexed.chat");
  writeFileSync(source, document());
  const sourcePage = jest.fn(async () => {
    if (disableDuringDiscovery) enabled = false;
    return { paths: [source] };
  });
  const runtime = createLiteCollaborators({
    directory: join(directory, "private"),
    path: directory,
    project_id,
    account_id,
    isEnabled: async () => enabled,
    sourcePage,
    agentPins: {
      read: () => [],
      set: () => {
        throw Error("unexpected pin write");
      },
    },
  });
  const fs = runtime.wrapFilesystem(
    new SandboxedFilesystem(directory, { unsafeMode: true, rootfs: "/" }),
    project_id,
  );
  try {
    const register = jest.spyOn(runtime.store, "registerSource");
    const ingest = jest.spyOn(runtime.store, "ingest");
    await fs.writeFile("queued.chat", document());
    await runtime.service.runOnce();
    expect(sourcePage).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect((await runtime.store.sourcePage({ project_id })).paths).toEqual([]);
    enabled = true;
    disableDuringDiscovery = true;
    await runtime.service.runOnce();
    expect(sourcePage).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect((await runtime.store.sourcePage({ project_id })).paths).toEqual([]);
    enabled = true;
    disableDuringDiscovery = false;
    // Backoff and discovery interval can expire without discarding queued work.
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    await runtime.service.runOnce();
    expect(register).toHaveBeenCalled();
    expect(ingest).toHaveBeenCalled();
    expect(
      (await runtime.api.listResources({ account_id })).items,
    ).toHaveLength(1);
    ingest.mockClear();
    enabled = false;
    await fs.writeFile("queued.chat", document("Disabled update"));
    await runtime.service.runOnce();
    expect(ingest).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
    fs.close();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit ensureRoom journals only its actual path without creating a chat file", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "lite-collaborators-room-source-"),
  );
  const runtime = createLiteCollaborators({
    directory: join(directory, "private"),
    path: directory,
    project_id,
    account_id,
    isEnabled: () => true,
    sourcePage: async () => ({ paths: [] }),
    agentPins: {
      read: () => [],
      set: () => {
        throw Error("unexpected pin write");
      },
    },
  });
  try {
    expect(runtime.service.journal.sources("", 100)).toEqual([]);
    expect((await runtime.store.sourcePage({ project_id })).paths).toEqual([]);
    await runtime.api.listProjects({ account_id });
    expect(runtime.service.journal.sources("", 100)).toEqual([]);
    const room = await runtime.api.ensureRoom({
      project_id,
      account_id,
      request_id: "explicit",
    });
    expect(room.chat_path).toBe(
      join(directory, ".cocalc", "collaborators.chat"),
    );
    expect(existsSync(room.chat_path)).toBe(false);
    expect(runtime.service.journal.sources("", 100)).toEqual([
      { project_id, chat_path: room.chat_path },
    ]);
    expect((await runtime.store.sourcePage({ project_id })).paths).toEqual([
      room.chat_path,
    ]);
    await runtime.service.runOnce();
    expect(existsSync(room.chat_path)).toBe(false);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("disabled filesystem delegation performs no collaborator traversal, identity lookup, or journaling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-collaborators-bypass-"));
  let enabled = false;
  const runtime = createLiteCollaborators({
    directory: join(directory, "private"),
    path: directory,
    project_id,
    account_id,
    isEnabled: () => enabled,
    sourcePage: async () => ({ paths: [] }),
    agentPins: { read: () => [], set: () => {} },
  });
  const filesystem: any = {};
  for (const name of [
    "writeFile",
    "appendFile",
    "unlink",
    "rm",
    "rmdir",
    "rename",
    "move",
    "copyFile",
    "cp",
  ])
    filesystem[name] = jest.fn(async () => "original-result");
  filesystem.canonicalSyncIdentityPath = jest.fn(async (path) =>
    join(directory, path),
  );
  filesystem.lstat = jest.fn(async () => {
    throw Error("unexpected tree scan");
  });
  const original = filesystem.cp;
  const wrapped = runtime.wrapFilesystem(filesystem, project_id);
  try {
    await expect(wrapped.cp("enormous-directory", "copy")).resolves.toBe(
      "original-result",
    );
    expect(original).toHaveBeenCalledTimes(1);
    expect(filesystem.lstat).not.toHaveBeenCalled();
    expect(filesystem.canonicalSyncIdentityPath).not.toHaveBeenCalled();
    expect(runtime.service.journal.sources("", 100)).toEqual([]);
    enabled = true;
    await expect(wrapped.cp("enormous-directory", "copy")).rejects.toThrow(
      "unexpected tree scan",
    );
    expect(original).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ready filesystem moves preserve identity and personal state through the shared producer", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "lite-collaborators-move-service-"),
  );
  const runtime = createLiteCollaborators({
    directory: join(directory, "private"),
    path: directory,
    project_id,
    account_id,
    isEnabled: () => true,
    sourcePage: async () => ({ paths: [] }),
    agentPins: { read: () => [], set: () => {} },
  });
  const fs = runtime.wrapFilesystem(
    new SandboxedFilesystem(directory, { unsafeMode: true, rootfs: "/" }),
    project_id,
  );
  const target = {
    project_id,
    account_id,
    kind: "conversation" as const,
    resource_id: thread_id,
  };
  try {
    await fs.writeFile("before.chat", document());
    await runtime.service.runOnce();
    await runtime.api.setPersonalState({
      ...target,
      patch: {
        alias: "notes",
        following: true,
        collected: true,
        read_through: 1,
      },
    });
    await fs.rename("before.chat", "after.chat");
    expect(runtime.service.journal.relocations()).toHaveLength(1);
    await runtime.service.runOnce();
    expect(runtime.service.journal.relocations()).toEqual([]);
    expect(await runtime.api.getResource(target)).toMatchObject({
      chat_path: join(directory, "after.chat"),
      activity: 1,
      personal: {
        alias: "notes",
        following: true,
        collected: true,
        read_through: 1,
      },
    });
    expect(
      (await runtime.api.listResources({ account_id })).items,
    ).toHaveLength(1);
    await fs.rename("after.chat", "before.chat");
    await runtime.service.runOnce();
    expect(runtime.service.journal.relocations()).toEqual([]);
    expect((await runtime.api.getResource(target))?.chat_path).toBe(
      join(directory, "before.chat"),
    );
  } finally {
    fs.close();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "journal-loss recovery restores retained activity floors (tombstoned: %s)",
  async (tombstoned) => {
    const directory = mkdtempSync(
      join(tmpdir(), "lite-collaborators-checkpoint-"),
    );
    const source = join(directory, "history.chat");
    const options = {
      directory: join(directory, "private"),
      path: directory,
      project_id,
      account_id,
      isEnabled: () => true,
      sourcePage: async () => ({ paths: [source] }),
      agentPins: { read: () => [], set: () => {} },
    };
    const rows = document()
      .split("\n")
      .map((line) => JSON.parse(line));
    const withMessages = (...ids: string[]) =>
      [...rows, ...ids.map((message_id) => ({ ...rows[2], message_id }))]
        .map((row) => JSON.stringify(row))
        .join("\n");
    writeFileSync(source, withMessages("message-2", "message-3"));
    let runtime = createLiteCollaborators(options);
    const target = {
      project_id,
      account_id,
      kind: "conversation" as const,
      resource_id: thread_id,
    };
    try {
      await runtime.service.runOnce();
      expect((await runtime.api.getResource(target))?.activity).toBe(3);
      await runtime.api.setPersonalState({
        ...target,
        patch: { read_through: 3 },
      });
      if (tombstoned) {
        rmSync(source);
        runtime.service.journal.touch({ project_id, chat_path: source });
        await runtime.service.runOnce();
        expect(await runtime.api.getResource(target)).toBeNull();
      }
      await runtime.close();
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(join(options.directory, `journal.sqlite${suffix}`), {
          force: true,
        });
      writeFileSync(source, document());
      runtime = createLiteCollaborators(options);
      await runtime.service.runOnce();
      expect(await runtime.api.getResource(target)).toMatchObject({
        activity: 3,
        personal: { read_through: 3 },
      });
      const fs = runtime.wrapFilesystem(
        new SandboxedFilesystem(directory, { unsafeMode: true, rootfs: "/" }),
        project_id,
      );
      try {
        await fs.writeFile(source, withMessages("message-4"));
        await runtime.service.runOnce();
      } finally {
        fs.close();
      }
      expect(await runtime.api.getResource(target)).toMatchObject({
        activity: 4,
        personal: { read_through: 3 },
      });
    } finally {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("filesystem moves coordinate both real catalog workers and the existing Library", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-collaborators-catalogs-"));
  const artifactDirectory = join(directory, "artifact-catalog");
  const artifactCatalog = createLiteArtifactCatalog({
    directory: artifactDirectory,
    path: directory,
    project_id,
    account_id,
  });
  // Drive the legacy worker one pass at a time without starting its timer.
  const runArtifacts = () =>
    (
      artifactCatalog.service as unknown as { runOnce(): Promise<void> }
    ).runOnce();
  const personalLibraryFilename = join(directory, "personal-library.sqlite");
  const library = new LitePersonalLibrary({
    filename: personalLibraryFilename,
    project_id,
    account_id,
    artifactExists: async (project_id, entry_id) =>
      !!(await artifactCatalog.catalog.getEntry({ project_id, entry_id })),
  });
  const runtime = createLiteCollaborators({
    directory: join(directory, "private"),
    path: directory,
    project_id,
    account_id,
    isEnabled: () => true,
    sourcePage: (opts) => artifactCatalog.catalog.sourcePage(opts),
    artifactCatalog: {
      catalog: artifactCatalog.catalog,
      journal: artifactCatalog.service.journal,
      filename: join(artifactDirectory, "catalog.sqlite"),
    },
    personalLibrary: () => library,
    personalLibraryFilename,
    agentPins: { read: () => [], set: () => {} },
  });
  const fs = runtime.wrapFilesystem(
    artifactCatalog.wrapFilesystem(
      new SandboxedFilesystem(directory, { unsafeMode: true, rootfs: "/" }),
      project_id,
    ),
    project_id,
  );
  try {
    const rows = document()
      .split("\n")
      .map((line) => JSON.parse(line));
    rows[1].notification_followers = [account_id];
    rows[1].notification_muted = [account_id];
    publishArtifact(
      {
        get_one: (key: any) =>
          rows.find((row) =>
            Object.entries(key).every(([key, value]) => row[key] === value),
          ),
        set: (values: any[]) => rows.push(...values),
      },
      {
        thread_id,
        artifact_id: "notes",
        operation_id: "publication-1",
        message_id,
        title: "Notes",
        markdown: "Private artifact body",
      },
    );
    await fs.writeFile(
      "before.chat",
      rows.map((row) => JSON.stringify(row)).join("\n"),
    );
    await runArtifacts();
    await runtime.service.runOnce();
    const original = (
      await runtime.api.listResources({ account_id })
    ).items.find((resource) => resource.kind === "artifact")!;
    expect(original).toBeDefined();
    expect(
      await runtime.api.getResource({
        account_id,
        project_id,
        kind: "conversation",
        resource_id: thread_id,
      }),
    ).toMatchObject({
      personal: { following: true, muted: true },
    });
    const target = {
      account_id,
      project_id,
      kind: "artifact" as const,
      resource_id: original.resource_id,
    };
    await runtime.api.setPersonalState({
      ...target,
      patch: {
        alias: "notes",
        collected: true,
        following: true,
        read_through: 1,
      },
    });
    await fs.rename("before.chat", "after.chat");
    // Deliberately run the artifact worker first: it cannot delete/reindex either
    // side while the Collaborators filesystem journal has a pending move.
    await runArtifacts();
    expect(
      await artifactCatalog.catalog.getEntry({
        project_id,
        entry_id: original.entry_id!,
      }),
    ).toMatchObject({ chat_path: join(directory, "before.chat") });
    await runtime.service.runOnce();
    expect(runtime.service.journal.relocations()).toEqual([]);
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    await runArtifacts();
    await runtime.service.runOnce();
    const moved = await runtime.api.getResource(target);
    expect(moved).toMatchObject({
      resource_id: original.resource_id,
      chat_path: join(directory, "after.chat"),
      activity: 1,
      personal: {
        alias: "notes",
        collected: true,
        following: true,
        read_through: 1,
      },
    });
    expect(
      (await artifactCatalog.catalog.listProject({ project_id })).entries,
    ).toHaveLength(1);
    expect(
      await artifactCatalog.catalog.getEntry({
        project_id,
        entry_id: original.entry_id!,
      }),
    ).toMatchObject({ chat_path: moved!.chat_path, entry_id: moved!.entry_id });
    expect((await library.list({ account_id })).pins).toEqual([
      artifactPin(moved!),
    ]);
    await library.name({
      account_id,
      project_id,
      entry_id: original.entry_id!,
      name: "renamed",
    });
    expect((await runtime.api.getResource(target))?.personal?.alias).toBe(
      "renamed",
    );
    await library.setPinned({
      account_id,
      pin_key: artifactPin(original),
      pinned: false,
    });
    expect((await runtime.api.getResource(target))?.personal?.collected).toBe(
      false,
    );
  } finally {
    jest.restoreAllMocks();
    fs.close();
    await runtime.close();
    library.close();
    await artifactCatalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "initial unread boundaries cover all 125 threads across event batches (live: %s)",
  async (live) => {
    const directory = mkdtempSync(join(tmpdir(), "lite-attention-batch-"));
    const runtime = createLiteCollaborators({
      directory: join(directory, "private"),
      path: directory,
      account_id,
      project_id,
      isEnabled: () => true,
      sourcePage: async () => ({ paths: [] }),
      agentPins: { read: () => [], set: () => {} },
    });
    const fs = runtime.wrapFilesystem(
      new SandboxedFilesystem(directory, { unsafeMode: true, rootfs: "/" }),
      project_id,
    );
    try {
      const room = await runtime.api.ensureRoom({
        account_id,
        project_id,
        request_id: "explicit",
      });
      await runtime.ensureRoomDirectory(room);
      if (live) runtime.service.journal.armNotifications(room, room.room_id);
      const rows: any[] = [
        {
          event: "collaborators-room",
          project_id,
          room_id: room.room_id,
          mode: "human",
        },
      ];
      const firstMessageIds = new Map<string, string>();
      for (let i = 0; i < 125; i++) {
        const thread_id = randomUUID(),
          message_id = randomUUID();
        firstMessageIds.set(thread_id, message_id);
        const thread = document()
          .split("\n")
          .map((line) => ({ ...JSON.parse(line), thread_id }));
        Object.assign(thread[2], {
          message_id,
          history: [{ content: "First message" }],
        });
        rows.push(...thread);
      }
      await fs.writeFile(
        room.chat_path,
        rows.map((row) => JSON.stringify(row)).join("\n"),
      );
      const ingest = jest.spyOn(runtime.store, "ingest");
      await runtime.service.runOnce();
      const notifications = ingest.mock.calls.flatMap(
        ([opts]) => opts.snapshot.notification_events ?? [],
      );
      expect(notifications).toHaveLength(live ? 100 : 0);
      // The last 25 queued live events have not been delivered yet, but their
      // threads must not acquire a history/read floor from the complete snapshot.
      const resources = [] as any[];
      let cursor: string | undefined;
      do {
        const page = await runtime.api.listResources({
          account_id,
          after: cursor,
        });
        resources.push(...page.items);
        cursor = page.next;
      } while (cursor);
      expect(resources).toHaveLength(125);
      expect(
        resources.every(
          (r) => r.activity === 1 && r.personal.read_through === (live ? 0 : 1),
        ),
      ).toBe(true);
      await runtime.service.runOnce();
      expect(
        ingest.mock.calls.flatMap(
          ([opts]) => opts.snapshot.notification_events ?? [],
        ),
      ).toHaveLength(live ? 125 : 0);
      for (const [thread_id] of firstMessageIds) {
        expect(
          (
            await runtime.api.getResource({
              account_id,
              project_id,
              kind: "conversation",
              resource_id: thread_id,
            })
          )?.personal?.read_through,
        ).toBe(live ? 0 : 1);
      }
    } finally {
      fs.close();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
