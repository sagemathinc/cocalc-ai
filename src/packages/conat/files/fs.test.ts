describe("filesystem explicit routing", () => {
  it("requires an explicit Conat client for fsClient", async () => {
    const { fsClient } = await import("./fs");

    expect(() =>
      fsClient({
        subject: "fs.project-00000000-0000-4000-8000-000000000000",
      } as any),
    ).toThrow("must provide an explicit Conat client");
  });

  it("requires an explicit Conat client for fsServer", async () => {
    const { fsServer } = await import("./fs");

    await expect(
      fsServer({
        service: "fs-test",
        fs: async () =>
          ({
            watch: jest.fn(),
          }) as any,
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("can invalidate a cached filesystem subject", async () => {
    const { fsServer } = await import("./fs");
    const fs0 = jest.fn(async () => ({
      watch: jest.fn(),
      readFile: jest.fn(async () => "ok"),
    }));
    let handlers: any;
    const close = jest.fn();
    const client = {
      service: jest.fn(async (_subject, svc) => {
        handlers = svc;
        return { close };
      }),
    } as any;

    const server = await fsServer({
      service: "fs-test",
      client,
      fs: fs0 as any,
    });

    await handlers.readFile.call(
      { subject: "fs-test.project-00000000-0000-4000-8000-000000000000" },
      "/home/user/a.txt",
      "utf8",
    );
    await handlers.readFile.call(
      { subject: "fs-test.project-00000000-0000-4000-8000-000000000000" },
      "/home/user/a.txt",
      "utf8",
    );
    expect(fs0).toHaveBeenCalledTimes(1);

    server.invalidateSubject(
      "fs-test.project-00000000-0000-4000-8000-000000000000",
    );

    await handlers.readFile.call(
      { subject: "fs-test.project-00000000-0000-4000-8000-000000000000" },
      "/home/user/a.txt",
      "utf8",
    );
    expect(fs0).toHaveBeenCalledTimes(2);
  });

  it("reuses an existing watch server when the subject is already registered", async () => {
    const { fsClient } = await import("./fs");
    const { EventEmitter } = await import("events");
    const subject = "fs.project-00000000-0000-4000-8000-000000000000";
    const ensureWatchServerExists = jest.fn(async () => {
      throw new Error(
        "there can be at most one socket server per client listening on a subject (subject='watch-fs.project-00000000-0000-4000-8000-000000000000')",
      );
    });
    const call = new Proxy(
      {
        exists: jest.fn(async () => true),
        watch: ensureWatchServerExists,
      },
      {
        get(target, prop) {
          if (!(prop in target)) {
            target[prop] = jest.fn();
          }
          return target[prop];
        },
      },
    );
    const socket = new EventEmitter() as EventEmitter & {
      request: jest.Mock<Promise<void>, [any]>;
      close: jest.Mock<void, []>;
    };
    socket.request = jest.fn(async () => {});
    socket.close = jest.fn();
    const client = {
      call: jest.fn(() => call),
      socket: {
        connect: jest.fn(() => socket),
      },
    } as any;

    const fs = fsClient({ client, subject });
    const watcher = await fs.watch("/tmp/test.txt");
    expect(ensureWatchServerExists).toHaveBeenCalledWith(
      "/tmp/test.txt",
      undefined,
    );
    expect(client.socket.connect).toHaveBeenCalledWith(`watch-${subject}`);
    expect(socket.request).toHaveBeenCalledWith({
      path: "/tmp/test.txt",
      options: undefined,
    });
    expect(typeof watcher.ignore).toBe("function");
  });
});
