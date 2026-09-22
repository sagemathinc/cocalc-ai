import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactCatalogSource } from "@cocalc/util/artifact-catalog";
import { ArtifactCatalogService } from "./service";

const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/a.chat",
};
let dir: string;
let services: Set<ArtifactCatalogService>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "artifact-service-"));
  services = new Set();
  jest.useFakeTimers();
});

afterEach(async () => {
  for (const service of services) await service.close();
  jest.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function options() {
  return {
    filename: join(dir, "journal.sqlite"),
    read: jest.fn(async () => []),
    writerState: jest.fn(async () => null),
    register: jest.fn(async () => ({ epoch: "epoch" })),
    send: jest.fn(async () => {}),
    discover: jest.fn(async (): Promise<ArtifactCatalogSource[]> => []),
    onError: jest.fn(),
  };
}

function create(opts = options()) {
  const service = new ArtifactCatalogService(opts);
  services.add(service);
  return service;
}

async function close(service: ArtifactCatalogService) {
  await service.close();
  services.delete(service);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("exclusive lock rejects another service before it can recover active writes", async () => {
  const opts = options();
  const first = create(opts);
  first.journal.register(source, "epoch");
  const token = first.journal.beginWrite(source);
  expect(() => create(opts)).toThrow(/locked/i);
  expect(() => create(opts)).toThrow(/locked/i);
  expect(first.journal.scans()).toEqual([]);
  first.journal.finishWrite(token);
  expect(first.journal.scans()).toHaveLength(1);
  await close(first);
  const next = create(opts);
  expect(next.journal.scans()).toHaveLength(1);
});

test("a successor recovers interrupted durable intents only after lock release", async () => {
  const opts = options();
  const first = create(opts);
  first.journal.register(source, "epoch");
  const generation = first.journal.scans()[0].generation;
  first.journal.beginWrite(source);
  expect(first.journal.scans()).toEqual([]);
  await close(first);
  const next = create(opts);
  expect(next.journal.scans()).toEqual([
    expect.objectContaining({ ...source, generation: generation + 2 }),
  ]);
  next.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(opts.send).toHaveBeenCalledWith(
    expect.objectContaining({ ...source, items: [] }),
  );
  expect(next.journal.scans()).toEqual([]);
});

test("discovery accepts bounded pages, advances nonempty pages, and waits 30 seconds after an empty page", async () => {
  const opts = options();
  opts.discover.mockResolvedValueOnce(
    Array.from({ length: 100 }, (_, i) => ({
      ...source,
      chat_path: `/home/user/${i}.chat`,
    })),
  );
  const service = create(opts);
  expect(opts.discover).not.toHaveBeenCalled();
  service.start();
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(opts.discover).toHaveBeenCalledTimes(1);
  expect(service.journal.sources(source.project_id)).toHaveLength(100);
  expect(opts.register).toHaveBeenCalledTimes(16);
  expect(opts.read).toHaveBeenCalledTimes(16);
  expect(opts.send).toHaveBeenCalledTimes(16);
  await jest.advanceTimersByTimeAsync(1_999);
  expect(opts.discover).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(opts.discover).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(28_000);
  expect(opts.discover).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(2_000);
  expect(opts.discover).toHaveBeenCalledTimes(3);
  expect(opts.onError).not.toHaveBeenCalled();
}, 20_000);

test("oversized discovery pages are rejected atomically without preventing existing work", async () => {
  const opts = options();
  opts.discover.mockResolvedValue(
    Array.from({ length: 101 }, (_, i) => ({
      ...source,
      chat_path: `/home/user/${i}.chat`,
    })),
  );
  const service = create(opts);
  service.journal.register(source, "epoch");
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(opts.onError).toHaveBeenCalledWith(
    undefined,
    expect.objectContaining({
      message: "artifact discovery page exceeds limit",
    }),
  );
  expect(service.journal.sources(source.project_id)).toEqual([source]);
  expect(opts.send).toHaveBeenCalledTimes(1);
});

test.each([
  { interval: 2000, sources: [] },
  { interval: 2000, sources: [source] },
  { interval: 6000, sources: [] },
  { interval: 6000, sources: [source] },
])(
  "explicit discovery interval $interval governs empty and nonempty pages: $sources",
  async ({ interval, sources }) => {
    const opts = { ...options(), discoveryIntervalMs: interval };
    opts.discover.mockResolvedValue(sources);
    const service = create(opts);
    service.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(opts.discover).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(interval - 1);
    expect(opts.discover).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(opts.discover).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(interval);
    expect(opts.discover).toHaveBeenCalledTimes(3);
    expect(opts.onError).not.toHaveBeenCalled();
  },
);

test("an explicit short interval also advances discovery after failures", async () => {
  const opts = { ...options(), discoveryIntervalMs: 2000 };
  const failure = Error("project discovery failed");
  opts.discover.mockRejectedValueOnce(failure);
  const service = create(opts);
  service.start();
  await jest.advanceTimersByTimeAsync(1999);
  expect(opts.onError).toHaveBeenCalledWith(undefined, failure);
  expect(opts.discover).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(opts.discover).toHaveBeenCalledTimes(2);
});

test("discovery errors are reported and retried only at the discovery interval", async () => {
  const opts = options();
  const failure = Error("discovery unavailable");
  opts.discover.mockRejectedValueOnce(failure);
  const service = create(opts);
  service.start();
  await jest.advanceTimersByTimeAsync(28_000);
  expect(opts.onError).toHaveBeenCalledWith(undefined, failure);
  expect(opts.discover).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(2_000);
  expect(opts.discover).toHaveBeenCalledTimes(2);
});

test("close drains discovery while retaining the lock and never schedules or ingests after stop", async () => {
  const opts = options();
  const gate = deferred<ArtifactCatalogSource[]>();
  opts.discover.mockReturnValueOnce(gate.promise);
  const service = create(opts);
  service.start();
  service.start();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(opts.discover).toHaveBeenCalledTimes(1);
  let closed = false;
  const closing = close(service).then(() => {
    closed = true;
  });
  try {
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => create(opts)).toThrow(/locked/i);
  } finally {
    gate.resolve([source]);
    await closing;
  }
  service.start();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(opts.discover).toHaveBeenCalledTimes(1);
  expect(opts.register).not.toHaveBeenCalled();
  expect(opts.send).not.toHaveBeenCalled();
  expect(create(opts).journal.sources(source.project_id)).toEqual([]);
});

test("close during read leaves reconciliation durable and suppresses the stopped projection", async () => {
  const opts = options();
  const gate = deferred<[]>();
  opts.read.mockReturnValueOnce(gate.promise);
  const service = create(opts);
  service.journal.register(source, "epoch");
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(opts.read).toHaveBeenCalledTimes(1);
  const closing = close(service);
  gate.resolve([]);
  await closing;
  expect(opts.send).not.toHaveBeenCalled();
  const successor = create(opts);
  expect(successor.journal.scans()).toHaveLength(1);
  successor.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(opts.send).toHaveBeenCalledTimes(1);
});

test("close cancels the scheduled timer and start cannot restart a closed service", async () => {
  const opts = options();
  const service = create(opts);
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(jest.getTimerCount()).toBe(1);
  await close(service);
  expect(jest.getTimerCount()).toBe(0);
  service.start();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(opts.discover).toHaveBeenCalledTimes(1);
  expect(opts.onError).not.toHaveBeenCalled();
});

test("stop cancels background work but retains the journal and exclusive lock until close", async () => {
  const opts = options();
  const service = create(opts);
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  service.stop();
  service.stop();
  expect(jest.getTimerCount()).toBe(0);
  service.journal.finishWrite(service.journal.beginWrite(source));
  expect(service.journal.sources(source.project_id)).toEqual([source]);
  expect(() => create(opts)).toThrow(/locked/i);
  service.start();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(opts.discover).toHaveBeenCalledTimes(1);
  expect(opts.register).not.toHaveBeenCalled();
  await close(service);
  expect(create(opts).journal.sources(source.project_id)).toEqual([source]);
});
