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

function create(
  opts: ConstructorParameters<typeof ArtifactCatalogService>[0] = options(),
) {
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

test("returning to a former host re-registers and rescans without retrying old contents", async () => {
  const opts = options();
  let owner = "A";
  let remote = {
    epoch: "epoch-A",
    writer_host_id: "A",
    registration_id: "original",
  };
  const recoverWriter = jest.fn(async (_source, expectedEpoch) => {
    if (owner !== "A") throw Error("not the current owner/host");
    return remote.epoch !== expectedEpoch && remote.writer_host_id !== "A"
      ? { epoch: remote.epoch }
      : undefined;
  });
  const sent: unknown[] = [];
  const send = jest.fn(async (snapshot) => {
    if (owner !== "A") throw Error("not the current owner/host");
    if (snapshot.epoch !== remote.epoch) throw Error("stale writer epoch");
    sent.push(snapshot);
  });
  const register = jest.fn(async (request) => {
    if (owner !== "A") throw Error("not the current owner/host");
    if (remote.registration_id === request.registration_id) return remote;
    if (request.expected_epoch !== remote.epoch) throw Error("epoch changed");
    remote = {
      epoch: "epoch-A-returned",
      writer_host_id: "A",
      registration_id: request.registration_id,
    };
    // The response is lost after commit. Retry must retain the identical CAS.
    throw Error("response lost");
  });
  const service = create({ ...opts, register, send, recoverWriter });
  service.journal.register(source, remote.epoch);
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(sent).toHaveLength(1);

  owner = "B";
  remote = {
    epoch: "epoch-B",
    writer_host_id: "B",
    registration_id: "B-registration",
  };
  service.journal.finishWrite(service.journal.beginWrite(source));
  await jest.advanceTimersByTimeAsync(2000);
  expect(register).not.toHaveBeenCalled();
  expect(service.journal.pendingRegistrations()).toEqual([]);
  expect(sent).toHaveLength(1);

  owner = "A";
  await jest.advanceTimersByTimeAsync(2000);
  expect(service.journal.pendingRegistrations()).toHaveLength(1);
  expect(service.journal.deliveries()).toEqual([]);
  const pending = service.journal.pendingRegistrations()[0];
  expect(service.journal.registrationBase(pending)).toEqual({
    expected_epoch: "epoch-B",
  });
  await jest.advanceTimersByTimeAsync(4000);
  expect(register).toHaveBeenCalledTimes(2);
  expect(register.mock.calls[1][0]).toEqual(register.mock.calls[0][0]);
  expect(opts.read).toHaveBeenCalledTimes(3);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({
    epoch: "epoch-A-returned",
    sequence: 1,
    items: [],
  });
  expect(service.journal.scans()).toEqual([]);
});

test("a pending registration may recover a foreign host's intervening epoch", async () => {
  const opts = options();
  const recoverWriter = jest.fn(async () => ({ epoch: "new-owner-epoch" }));
  const register = jest
    .fn()
    .mockRejectedValueOnce(Error("epoch changed"))
    .mockResolvedValue({ epoch: "returned-epoch" });
  const service = create({ ...opts, register, recoverWriter });
  service.journal.finishWrite(service.journal.beginWrite(source));
  const prior = service.journal.pendingRegistrations()[0];
  service.journal.prepareRegistration(prior, "old-owner-epoch");
  service.start();
  await jest.advanceTimersByTimeAsync(2000);
  expect(register.mock.calls[0][0]).toMatchObject({
    ...prior,
    expected_epoch: "old-owner-epoch",
  });
  expect(register.mock.calls[1][0]).toMatchObject({
    expected_epoch: "new-owner-epoch",
  });
  expect(register.mock.calls[1][0].registration_id).not.toBe(
    prior.registration_id,
  );
  expect(opts.send).toHaveBeenCalledWith(
    expect.objectContaining({ epoch: "returned-epoch" }),
  );
});

test("stop during authority recovery retains the old journal for the successor", async () => {
  const opts = options();
  const gate = deferred<{ epoch: string }>();
  const recoverWriter = jest.fn(() => gate.promise);
  opts.send.mockRejectedValue(Error("stale writer epoch"));
  const service = create({ ...opts, recoverWriter });
  service.journal.register(source, "old-epoch");
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(recoverWriter).toHaveBeenCalledTimes(1);
  const closing = close(service);
  gate.resolve({ epoch: "new-epoch" });
  await closing;
  const successor = create(opts);
  expect(successor.journal.pendingRegistrations()).toEqual([]);
  expect(successor.journal.deliveries(16, Date.now() + 60000)[0].epoch).toBe(
    "old-epoch",
  );
});
