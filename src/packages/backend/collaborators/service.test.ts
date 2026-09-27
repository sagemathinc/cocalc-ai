import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaboratorsService } from "./service";
const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/a.chat",
};
let directory: string, instances: CollaboratorsService[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaborators-service-"));
  instances = [];
});
afterEach(async () => {
  for (const instance of instances) await instance.close();
  rmSync(directory, { recursive: true, force: true });
});
function setup(overrides = {}) {
  const opts = {
    filename: join(directory, "journal.sqlite"),
    read: jest.fn(async () => ({ resources: [], activity_ids: {} })),
    writerState: jest.fn(
      async (): Promise<{
        epoch: string;
        registration_id: string | null;
      } | null> => null,
    ),
    register: jest.fn(async () => ({ epoch: "epoch-1" })),
    send: jest.fn(async () => ({ revision: 1, replayed: false })),
    discover: jest.fn(async () => []),
    onError: jest.fn(),
    now: () => 0,
    ...overrides,
  };
  const service = new CollaboratorsService(opts);
  instances.push(service);
  return { service, opts };
}
test("service process lock rejects a concurrent worker", () => {
  setup();
  expect(() => setup()).toThrow();
});
test("registration and ingest retry stable payloads after dropped acknowledgments", async () => {
  let now = 0;
  const { service, opts } = setup({ now: () => now });
  service.journal.touch(source);
  opts.register.mockRejectedValueOnce(Error("registration ack lost"));
  await service.runOnce();
  expect(opts.send).not.toHaveBeenCalled();
  now = 2000;
  opts.send.mockRejectedValueOnce(Error("ingest ack lost"));
  await service.runOnce();
  now = 4000;
  await service.runOnce();
  expect(opts.register.mock.calls[0]).toEqual(opts.register.mock.calls[1]);
  expect(opts.send.mock.calls[0]).toEqual(opts.send.mock.calls[1]);
  expect(service.journal.deliveries(16, now)).toEqual([]);
});
test("source parse failure does not publish an empty replacement", async () => {
  const { service, opts } = setup();
  service.journal.touch(source);
  opts.read.mockRejectedValueOnce(Error("invalid source JSON"));
  await service.runOnce();
  expect(opts.send).not.toHaveBeenCalled();
  expect(opts.onError).toHaveBeenCalled();
});
test("beforeRead flush refreshes generation before extraction instead of starving publication", async () => {
  const beforeRead = jest.fn(async () => {
    service.journal.touch(source);
  });
  const { service, opts } = setup({ beforeRead });
  service.journal.touch(source);
  await service.runOnce();
  expect(beforeRead).toHaveBeenCalledTimes(1);
  expect(opts.read).toHaveBeenCalledWith(
    expect.objectContaining({ generation: 2 }),
  );
  expect(opts.send).toHaveBeenCalledTimes(1);
  expect(service.journal.scans()).toEqual([]);
});
test.each(["copy", "relocation", "epoch", "write"])(
  "post-flush refresh preserves %s fencing",
  async (kind) => {
    const beforeRead = jest.fn(async () => {
      if (kind === "copy")
        service.journal.beginCopy(source, "/home/user/copied.chat", false);
      else if (kind === "relocation")
        service.journal.beginRelocation(source, "/home/user/moved.chat");
      else if (kind === "epoch")
        service.journal.reassign(source, "other-epoch");
      else service.journal.beginWrite(source);
    });
    const { service, opts } = setup({ beforeRead });
    service.journal.touch(source);
    await service.runOnce();
    expect(opts.read).not.toHaveBeenCalled();
    expect(opts.send).not.toHaveBeenCalled();
  },
);
test("failed browser-history flush remains durable dirty work across worker restart", async () => {
  const beforeRead = jest.fn(async () => {
    throw Error("disk ACK lost");
  });
  const { service, opts } = setup({ beforeRead });
  service.journal.touch(source);
  await service.runOnce();
  expect(opts.read).not.toHaveBeenCalled();
  expect(opts.send).not.toHaveBeenCalled();
  await service.close();
  instances = [];
  const afterRestart = jest.fn(async () => {});
  const next = setup({ beforeRead: afterRestart, now: () => 2000 });
  await next.service.runOnce();
  expect(afterRestart).toHaveBeenCalledTimes(1);
  expect(next.opts.send).toHaveBeenCalledTimes(1);
});
test("disabled gate skips beforeRead and a flag change during flush skips extraction", async () => {
  const enabled = jest.fn(async () => false);
  const beforeRead = jest.fn(async () => {
    enabled.mockResolvedValue(false);
  });
  const { service, opts } = setup({ enabled, beforeRead });
  service.journal.touch(source);
  await service.runOnce();
  expect(beforeRead).not.toHaveBeenCalled();
  enabled.mockResolvedValue(true);
  await service.runOnce();
  expect(beforeRead).toHaveBeenCalledTimes(1);
  expect(opts.read).not.toHaveBeenCalled();
});
test("new host freezes owner epoch before registration and does not refresh it on ordinary retry", async () => {
  let now = 0;
  const { service, opts } = setup({ now: () => now });
  service.journal.touch(source);
  opts.writerState.mockResolvedValueOnce({
    epoch: "old-host-epoch",
    registration_id: "old-host-registration",
  });
  opts.writerState.mockResolvedValue({
    epoch: "observed-after-lost-reply",
    registration_id: "other-registration",
  });
  opts.register.mockRejectedValueOnce(Error("lost ack"));
  await service.runOnce();
  expect(opts.register).toHaveBeenCalledWith(
    expect.objectContaining({ expected_epoch: "old-host-epoch" }),
  );
  now = 2000;
  await service.runOnce();
  // Recovery may probe retired-room state, but must not refresh the CAS base.
  expect(opts.writerState).toHaveBeenCalledTimes(2);
  expect(opts.register.mock.calls[1]).toEqual(opts.register.mock.calls[0]);
});
test("authoritative reassignment recovery replaces stale epoch and discards old delivery", async () => {
  let now = 0;
  const recoverWriter = jest.fn(async () => ({
    epoch: "reassigned-host-epoch",
  }));
  const { service, opts } = setup({ now: () => now, recoverWriter });
  service.journal.touch(source);
  opts.send.mockRejectedValueOnce(Error("fenced"));
  await service.runOnce();
  expect(recoverWriter).toHaveBeenCalledWith(
    expect.objectContaining(source),
    "epoch-1",
  );
  expect(service.journal.deliveries()).toEqual([]);
  now = 2000;
  await service.runOnce();
  expect(opts.register).toHaveBeenLastCalledWith(
    expect.objectContaining({ expected_epoch: "reassigned-host-epoch" }),
  );
});
test("close drains in-flight work and does not write after closing journal", async () => {
  let resolve!: (value: { resources: []; activity_ids: {} }) => void;
  const { service, opts } = setup({
    read: jest.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  });
  service.journal.touch(source);
  const running = service.runOnce();
  await new Promise((r) => setImmediate(r));
  const closing = service.close();
  resolve({ resources: [], activity_ids: {} });
  await Promise.all([running, closing]);
  instances = [];
  expect(opts.send).not.toHaveBeenCalled();
});
test.each(["relocation", "copy", "reassignment"])(
  "captured delivery batch rechecks %s fencing before each send",
  async (transition) => {
    const { service, opts } = setup();
    const second = { ...source, chat_path: "/home/user/b.chat" };
    service.journal.touch(source);
    service.journal.touch(second);
    opts.send.mockImplementationOnce(async () => {
      if (transition === "relocation") {
        const operation = service.journal.beginRelocation(
          second,
          "/home/user/moved.chat",
        );
        service.journal.finishRelocation(operation, true);
      } else if (transition === "copy") {
        service.journal.beginCopy(second, "/home/user/original.chat", false);
      } else service.journal.reassign(second, "new-owner-epoch");
      return { revision: 1, replayed: false };
    });
    await service.runOnce();
    expect(opts.send).toHaveBeenCalledTimes(1);
    expect(opts.send).toHaveBeenCalledWith(expect.objectContaining(source));
  },
);
test("captured registration batches do not register a destination fenced during another lookup", async () => {
  const { service, opts } = setup();
  const second = { ...source, chat_path: "/home/user/b.chat" };
  service.journal.touch(source);
  service.journal.touch(second);
  opts.writerState.mockImplementationOnce(async () => {
    service.journal.beginRelocation(
      { ...source, chat_path: "/home/user/z.chat" },
      second.chat_path,
    );
    return null;
  });
  await service.runOnce();
  expect(opts.register).toHaveBeenCalledTimes(1);
  expect(opts.writerState).toHaveBeenCalledTimes(1);
});
test("registration rechecks its destination after an in-flight writer lookup", async () => {
  const { service, opts } = setup();
  service.journal.touch(source);
  opts.writerState.mockImplementationOnce(async () => {
    service.journal.beginRelocation(
      { ...source, chat_path: "/home/user/z.chat" },
      source.chat_path,
    );
    return null;
  });
  await service.runOnce();
  expect(opts.register).not.toHaveBeenCalled();
});
