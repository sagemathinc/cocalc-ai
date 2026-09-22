/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactCatalogService } from "@cocalc/backend/artifacts/service";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type { ArtifactCatalogSnapshot } from "@cocalc/util/artifact-catalog";

type Options = ConstructorParameters<typeof ArtifactCatalogService>[0];
type Adapter = typeof import("./artifact-catalog");

const projectA = "11111111-1111-4111-8111-111111111111";
const projectB = "22222222-2222-4222-8222-222222222222";
const projectC = "33333333-3333-4333-8333-333333333333";
const source = { project_id: projectA, chat_path: "/home/user/a.chat" };
const registration = {
  ...source,
  registration_id: "registration",
  expected_epoch: null,
};
const snapshot: ArtifactCatalogSnapshot = {
  ...source,
  schema_version: 1,
  epoch: "epoch",
  sequence: 1,
  items: [],
};

let directory: string;
let adapter: Adapter;
let options: Options;
let construct: jest.Mock;
let instance: {
  journal: object;
  start: jest.Mock;
  stop: jest.Mock;
  close: jest.Mock;
};
let fs: SandboxedFilesystem;
let closeFilesystem: jest.Mock;
let getFilesystem: jest.Mock;
let read: jest.Mock;
let extract: jest.Mock;
let wrap: jest.Mock;
let callHub: jest.Mock;
let getClient: jest.Mock;
let getHostId: jest.Mock;
let listProjects: jest.Mock;
let warn: jest.Mock;
let now: number;

beforeEach(async () => {
  jest.resetModules();
  directory = await mkdtemp(join(tmpdir(), "host-artifact-catalog-"));
  now = 1_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  closeFilesystem = jest.fn();
  fs = { close: closeFilesystem } as unknown as SandboxedFilesystem;
  getFilesystem = jest.fn().mockResolvedValue(fs);
  read = jest.fn().mockResolvedValue([]);
  extract = jest.fn().mockReturnValue([]);
  wrap = jest.fn().mockImplementation((value) => value);
  callHub = jest.fn().mockResolvedValue({ paths: [] });
  getClient = jest.fn().mockReturnValue({ connection: "master" });
  getHostId = jest.fn().mockReturnValue("authenticated-host");
  listProjects = jest.fn().mockReturnValue([{ project_id: projectA }]);
  warn = jest.fn();
  instance = {
    journal: {},
    start: jest.fn(),
    stop: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  construct = jest.fn().mockImplementation((value: Options) => {
    options = value;
    return instance;
  });
  jest.doMock("@cocalc/backend/artifacts/service", () => ({
    ArtifactCatalogService: construct,
  }));
  jest.doMock("@cocalc/backend/artifacts/filesystem", () => ({
    readArtifactSource: read,
    journalArtifactFilesystem: wrap,
  }));
  jest.doMock("@cocalc/chat", () => ({ extractArtifactCatalog: extract }));
  jest.doMock("@cocalc/backend/data", () => ({ data: directory }));
  jest.doMock("@cocalc/backend/logger", () => ({
    __esModule: true,
    default: () => ({ warn }),
  }));
  jest.doMock("@cocalc/conat/hub/call-hub", () => ({
    __esModule: true,
    default: callHub,
  }));
  jest.doMock("./master-conat-client", () => ({
    getMasterConatClient: getClient,
  }));
  jest.doMock("./sqlite/hosts", () => ({ getLocalHostId: getHostId }));
  jest.doMock("./sqlite/projects", () => ({ listProjects }));
  adapter = require("./artifact-catalog");
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function start() {
  return adapter.startArtifactCatalog(getFilesystem);
}

function rpc(name: string, args: unknown) {
  return {
    client: getClient.mock.results.at(-1)?.value,
    host_id: getHostId.mock.results.at(-1)?.value,
    name: `artifactCatalog.${name}`,
    args: [args],
  };
}

test("starts one service in a private data directory without starting or opening any project", async () => {
  expect(construct).not.toHaveBeenCalled();
  expect(start()).toBe(instance);
  const unusedFilesystem = jest.fn();
  expect(adapter.startArtifactCatalog(unusedFilesystem)).toBe(instance);
  expect(construct).toHaveBeenCalledTimes(1);
  expect(instance.start).toHaveBeenCalledTimes(1);
  expect(options.discoveryIntervalMs).toBe(2000);
  expect(options.filename).toBe(
    join(directory, "artifact-catalog", "journal.sqlite"),
  );
  expect((await stat(join(directory, "artifact-catalog"))).mode & 0o777).toBe(
    0o700,
  );
  expect(getFilesystem).not.toHaveBeenCalled();
  expect(unusedFilesystem).not.toHaveBeenCalled();
  expect(callHub).not.toHaveBeenCalled();
});

test("filesystem wrapping is inert before startup and uses the service journal afterwards", () => {
  expect(adapter.withArtifactCatalog(fs, projectA)).toBe(fs);
  expect(wrap).not.toHaveBeenCalled();
  start();
  const wrapped = {} as SandboxedFilesystem;
  wrap.mockReturnValueOnce(wrapped);
  expect(adapter.withArtifactCatalog(fs, projectA)).toBe(wrapped);
  expect(wrap).toHaveBeenCalledWith(fs, projectA, instance.journal);
});

test("writer lookup, registration, and ingestion carry fresh authenticated host context and exact payloads", async () => {
  start();
  const state = { epoch: "old", registration_id: "old-registration" };
  callHub.mockResolvedValueOnce(state);
  await expect(options.writerState(source)).resolves.toBe(state);
  expect(callHub).toHaveBeenLastCalledWith(rpc("writerState", source));
  getClient.mockReturnValue({ connection: "reconnected-master" });
  getHostId.mockReturnValue("replacement-host");
  callHub.mockResolvedValueOnce({ epoch: "new" });
  await expect(options.register(registration)).resolves.toEqual({
    epoch: "new",
  });
  expect(callHub).toHaveBeenLastCalledWith(rpc("registerSource", registration));
  callHub.mockResolvedValueOnce({ revision: 1, replayed: false });
  await options.send(snapshot);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("ingest", { ...snapshot, snapshot }),
  );
  expect(getClient).toHaveBeenCalledTimes(3);
  expect(getHostId).toHaveBeenCalledTimes(3);
  expect(getFilesystem).not.toHaveBeenCalled();
});

test.each(["client", "host"])(
  "missing %s fails before any RPC or filesystem access",
  async (missing) => {
    start();
    (missing === "client" ? getClient : getHostId).mockReturnValue(undefined);
    await expect(options.writerState(source)).rejects.toThrow(
      "catalog owner connection unavailable",
    );
    await expect(options.register(registration)).rejects.toThrow(
      "catalog owner connection unavailable",
    );
    await expect(options.send(snapshot)).rejects.toThrow(
      "catalog owner connection unavailable",
    );
    await expect(options.discover()).rejects.toThrow(
      "catalog owner connection unavailable",
    );
    expect(callHub).not.toHaveBeenCalled();
    expect(getFilesystem).not.toHaveBeenCalled();
  },
);

test.each(["writerState", "register", "send", "discover"] as const)(
  "%s rejects legacy error envelopes",
  async (operation) => {
    start();
    callHub.mockResolvedValue({ error: "owner rejected request" });
    const operations = {
      writerState: () => options.writerState(source),
      register: () => options.register(registration),
      send: () => options.send(snapshot),
      discover: () => options.discover(),
    };
    await expect(operations[operation]()).rejects.toThrow(
      "owner rejected request",
    );
  },
);

test("transport errors retain their identity rather than becoming successful ingestion", async () => {
  start();
  const failure = Error("connection lost");
  callHub.mockRejectedValueOnce(failure);
  await expect(options.send(snapshot)).rejects.toBe(failure);
});

test("reads the requested canonical source through the sandbox, extracts it, and closes the sandbox", async () => {
  start();
  const rows = [{ event: "chat-event" }];
  const items = [{ artifact_id: "extracted" }];
  read.mockResolvedValueOnce(rows);
  extract.mockReturnValueOnce(items);
  await expect(options.read(source)).resolves.toBe(items);
  expect(getFilesystem).toHaveBeenCalledWith(projectA);
  expect(read).toHaveBeenCalledWith(fs, source.chat_path);
  expect(extract).toHaveBeenCalledWith(rows);
  expect(closeFilesystem).toHaveBeenCalledTimes(1);
  expect(callHub).not.toHaveBeenCalled();
});

test.each(["reader", "extractor"])(
  "%s errors propagate and still close the filesystem",
  async (stage) => {
    start();
    const failure = Error(`${stage} failed`);
    if (stage === "reader") read.mockRejectedValueOnce(failure);
    else
      extract.mockImplementationOnce(() => {
        throw failure;
      });
    await expect(options.read(source)).rejects.toBe(failure);
    expect(closeFilesystem).toHaveBeenCalledTimes(1);
    if (stage === "reader") expect(extract).not.toHaveBeenCalled();
  },
);

test("filesystem acquisition errors propagate without reading or closing an unacquired sandbox", async () => {
  start();
  const failure = Error("project storage unavailable");
  getFilesystem.mockRejectedValueOnce(failure);
  await expect(options.read(source)).rejects.toBe(failure);
  expect(read).not.toHaveBeenCalled();
  expect(closeFilesystem).not.toHaveBeenCalled();
});

test("an in-flight read keeps its filesystem open until the reader settles", async () => {
  start();
  let release!: (rows: unknown[]) => void;
  const gate = new Promise<unknown[]>((resolve) => {
    release = resolve;
  });
  read.mockReturnValueOnce(gate);
  const pending = options.read(source);
  await Promise.resolve();
  try {
    expect(read).toHaveBeenCalledTimes(1);
    expect(closeFilesystem).not.toHaveBeenCalled();
  } finally {
    release([]);
    await pending;
  }
  expect(closeFilesystem).toHaveBeenCalledTimes(1);
});

test("discovery fetches one page per pass, rotates sorted nonlocal projects, and emits a round-ending empty page", async () => {
  listProjects.mockReturnValue([
    { project_id: projectC },
    { project_id: projectB, local_only: true },
    { project_id: projectA, state: "stopped" },
  ]);
  callHub
    .mockResolvedValueOnce({ paths: ["/home/user/a.chat"], next: "page-two" })
    .mockResolvedValueOnce({ paths: ["/home/user/b.chat"] })
    .mockResolvedValueOnce({ paths: ["/home/user/c.chat"] })
    .mockResolvedValueOnce({ paths: [] });
  start();
  await expect(options.discover()).resolves.toEqual([source]);
  expect(callHub).toHaveBeenCalledTimes(1);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectA, after: undefined }),
  );
  await expect(options.discover()).resolves.toEqual([
    { project_id: projectA, chat_path: "/home/user/b.chat" },
  ]);
  expect(callHub).toHaveBeenCalledTimes(2);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectA, after: "page-two" }),
  );
  await expect(options.discover()).resolves.toEqual([
    { project_id: projectC, chat_path: "/home/user/c.chat" },
  ]);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectC, after: undefined }),
  );
  await expect(options.discover()).resolves.toEqual([]);
  expect(callHub).toHaveBeenCalledTimes(3);
  now += 29_999;
  await expect(options.discover()).resolves.toEqual([]);
  expect(callHub).toHaveBeenCalledTimes(3);
  now += 1;
  await expect(options.discover()).resolves.toEqual([]);
  expect(callHub).toHaveBeenCalledTimes(4);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectA, after: undefined }),
  );
  expect(getFilesystem).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(extract).not.toHaveBeenCalled();
});

test("a failed continuation advances to another project and retries the failed project from its first page next round", async () => {
  listProjects.mockReturnValue([
    { project_id: projectA },
    { project_id: projectB },
  ]);
  const failure = Error("project A unavailable");
  callHub
    .mockResolvedValueOnce({ paths: [source.chat_path], next: "failed-cursor" })
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ paths: ["/home/user/b.chat"] })
    .mockResolvedValueOnce({ paths: [source.chat_path] });
  start();
  await options.discover();
  await expect(options.discover()).rejects.toBe(failure);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectA, after: "failed-cursor" }),
  );
  await expect(options.discover()).resolves.toEqual([
    { project_id: projectB, chat_path: "/home/user/b.chat" },
  ]);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectB, after: undefined }),
  );
  await expect(options.discover()).resolves.toEqual([]);
  now += 30_000;
  await expect(options.discover()).resolves.toEqual([source]);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectA, after: undefined }),
  );
  expect(getFilesystem).not.toHaveBeenCalled();
});

test("failure on the last project does not strand discovery beyond the end of the project list", async () => {
  start();
  callHub.mockRejectedValueOnce(Error("last project failed"));
  await expect(options.discover()).rejects.toThrow("last project failed");
  await expect(options.discover()).resolves.toEqual([]);
  expect(callHub).toHaveBeenCalledTimes(1);
  now += 29_999;
  await expect(options.discover()).resolves.toEqual([]);
  expect(callHub).toHaveBeenCalledTimes(1);
  now += 1;
  await options.discover();
  expect(callHub).toHaveBeenCalledTimes(2);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectA, after: undefined }),
  );
});

test("empty and local-only project lists do no RPC work and newly assigned projects are discovered later", async () => {
  start();
  listProjects.mockReturnValue([]);
  await expect(options.discover()).resolves.toEqual([]);
  listProjects.mockReturnValue([{ project_id: projectA, local_only: true }]);
  now += 30_000;
  await expect(options.discover()).resolves.toEqual([]);
  expect(callHub).not.toHaveBeenCalled();
  listProjects.mockReturnValue([{ project_id: projectB }]);
  now += 29_999;
  await expect(options.discover()).resolves.toEqual([]);
  expect(callHub).not.toHaveBeenCalled();
  now += 1;
  await options.discover();
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectB, after: undefined }),
  );
  expect(getFilesystem).not.toHaveBeenCalled();
});

test("empty projects advance every two seconds with one cooldown only after the entire round", async () => {
  listProjects.mockReturnValue([
    { project_id: projectC },
    { project_id: projectA },
    { project_id: projectB },
  ]);
  start();
  expect(options.discoveryIntervalMs).toBe(2000);
  for (const project_id of [projectA, projectB, projectC]) {
    await expect(options.discover()).resolves.toEqual([]);
    expect(callHub).toHaveBeenLastCalledWith(
      rpc("sourcePage", { project_id, after: undefined }),
    );
    now += options.discoveryIntervalMs!;
  }
  expect(callHub).toHaveBeenCalledTimes(3);
  await expect(options.discover()).resolves.toEqual([]);
  const listCalls = listProjects.mock.calls.length;
  for (let elapsed = 2000; elapsed < 30_000; elapsed += 2000) {
    now += 2000;
    await expect(options.discover()).resolves.toEqual([]);
  }
  expect(callHub).toHaveBeenCalledTimes(3);
  expect(listProjects).toHaveBeenCalledTimes(listCalls);
  now += 2000;
  await expect(options.discover()).resolves.toEqual([]);
  expect(callHub).toHaveBeenCalledTimes(4);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectA, after: undefined }),
  );
  expect(getFilesystem).not.toHaveBeenCalled();
});

test("an empty page with a continuation stays on the same project without starting the round cooldown", async () => {
  start();
  callHub
    .mockResolvedValueOnce({ paths: [], next: "continuation" })
    .mockResolvedValueOnce({ paths: [source.chat_path] });
  await expect(options.discover()).resolves.toEqual([]);
  now += 2000;
  await expect(options.discover()).resolves.toEqual([source]);
  expect(callHub).toHaveBeenCalledTimes(2);
  expect(callHub).toHaveBeenLastCalledWith(
    rpc("sourcePage", { project_id: projectA, after: "continuation" }),
  );
});

test("returns the service lifecycle unchanged and keeps filesystem journaling attached after stop", () => {
  const service = start();
  service.stop();
  expect(instance.stop).toHaveBeenCalledTimes(1);
  expect(instance.close).not.toHaveBeenCalled();
  adapter.withArtifactCatalog(fs, projectA);
  expect(wrap).toHaveBeenCalledWith(fs, projectA, instance.journal);
  expect(start()).toBe(service);
  expect(instance.start).toHaveBeenCalledTimes(1);
});

test("reports both source-specific and discovery failures through the host logger", () => {
  start();
  options.onError(source, Error("read failed"));
  options.onError(undefined, Error("discovery failed"));
  expect(warn.mock.calls).toEqual([
    ["catalog indexing deferred", { source, error: "Error: read failed" }],
    [
      "catalog indexing deferred",
      { source: undefined, error: "Error: discovery failed" },
    ],
  ]);
});
