const testJupyter = {
  async importIpynb({ ipynb }) {
    return { ipynb };
  },
  async saveIpynb({ ipynb }) {
    return { ipynb, bytes: 0, converted: false };
  },
};

describe("filesystem explicit routing", () => {
  it("builds and parses shared directory filesystem subjects", async () => {
    const { parseShareFsSubject, shareFsSubject } = await import("./fs");
    const project_id = "00000000-0000-4000-8000-000000000000";
    const share_id = "22222222-2222-4222-8222-222222222222";
    const account_id = "11111111-1111-4111-8111-111111111111";

    const subject = shareFsSubject({ project_id, share_id, account_id });

    expect(subject).toBe(
      `fs-share.project-${project_id}.share-${share_id}.account-${account_id}`,
    );
    expect(parseShareFsSubject(subject)).toEqual({
      project_id,
      share_id,
      account_id,
    });
    expect(parseShareFsSubject(`fs-share.project-${project_id}`)).toBe(
      undefined,
    );
  });

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
        jupyter: testJupyter,
        fs: async () =>
          ({
            watch: jest.fn(),
          }) as any,
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("requires Jupyter handlers on every writable filesystem service", async () => {
    const { fsServer } = await import("./fs");
    const client = { service: jest.fn() } as any;

    await expect(
      fsServer({
        service: "fs-test",
        client,
        fs: async () => ({}) as any,
      } as any),
    ).rejects.toThrow("requires filesystem Jupyter handlers");
    expect(client.service).not.toHaveBeenCalled();
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
      jupyter: testJupyter,
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

  it("routes Jupyter conversion only through the writable filesystem service", async () => {
    const { fsServer } = await import("./fs");
    const filesystem = {
      writeFile: jest.fn(async () => {}),
    } as any;
    const importIpynb = jest.fn(async ({ ipynb }) => ({ ipynb }));
    const saveIpynb = jest.fn(async ({ ipynb }) => ({
      ipynb,
      bytes: 12,
      converted: false,
    }));
    const onMutation = jest.fn();
    let handlers: any;
    const client = {
      service: jest.fn(async (_subject, svc) => {
        handlers = svc;
        return { close: jest.fn() };
      }),
    } as any;
    const subject = "fs-test.project-00000000-0000-4000-8000-000000000000";

    const server = await fsServer({
      service: "fs-test",
      client,
      fs: async () => filesystem,
      onMutation,
      jupyter: { importIpynb, saveIpynb },
    });
    const ipynb = { cells: [] };

    await expect(
      handlers.jupyterImportIpynb.call({ subject }, ipynb),
    ).resolves.toEqual({ ipynb });
    await expect(
      handlers.jupyterSaveIpynb.call({ subject }, "a.ipynb", ipynb),
    ).resolves.toMatchObject({ bytes: 12 });
    expect(importIpynb).toHaveBeenCalledWith({ subject, ipynb });
    expect(saveIpynb).toHaveBeenCalledWith({
      subject,
      path: "a.ipynb",
      ipynb,
      fs: filesystem,
    });
    expect(onMutation).toHaveBeenCalledWith({
      subject,
      op: "jupyterSaveIpynb",
      path: "a.ipynb",
    });
    server.close();
  });

  it("does not expose Jupyter conversion on read-only filesystem services", async () => {
    const { fsReadOnlyServer } = await import("./fs");
    let handlers: any;
    const client = {
      service: jest.fn(async (_subject, svc) => {
        handlers = svc;
        return { close: jest.fn() };
      }),
    } as any;
    const server = await fsReadOnlyServer({
      service: "fs-viewer-test",
      client,
      fs: async () => ({}) as any,
    });

    expect(handlers.jupyterImportIpynb).toBeUndefined();
    expect(handlers.jupyterSaveIpynb).toBeUndefined();
    for (const method of ["writeFile", "mkdir", "rename", "copyFile", "rm"])
      expect(handlers[method]).toBeUndefined();
    server.close();
  });

  it("agent grant service exposes only the explicit mutation allowlist", async () => {
    const { fsAgentGrantServer } = await import("./fs");
    let handlers: any;
    const writeFile = jest.fn();
    const server = await fsAgentGrantServer({
      service: "fs-agent",
      client: {
        service: async (_subject, svc) => {
          handlers = svc;
          return { close: jest.fn() };
        },
      } as any,
      fs: async () => ({ writeFile }) as any,
    });
    try {
      for (const method of ["writeFile", "mkdir", "rename", "copyFile", "rm"])
        expect(typeof handlers[method]).toBe("function");
      for (const method of [
        "symlink",
        "link",
        "chmod",
        "cp",
        "move",
        "ouch",
        "watch",
        "jupyterSaveIpynb",
      ])
        expect(handlers[method]).toBeUndefined();
      await handlers.writeFile.call(
        { subject: "fs-agent.test" },
        "docs/a",
        "data",
      );
      expect(writeFile).toHaveBeenCalledWith("docs/a", "data", undefined);
    } finally {
      server.close();
    }
  });

  it("rejects read locks on read-only filesystem service", async () => {
    const { fsReadOnlyServer } = await import("./fs");
    const readFile = jest.fn(async () => "ok");
    let handlers: any;
    const close = jest.fn();
    const client = {
      service: jest.fn(async (_subject, svc) => {
        handlers = svc;
        return { close };
      }),
    } as any;

    const server = await fsReadOnlyServer({
      service: "fs-viewer-test",
      client,
      fs: jest.fn(async () => ({ readFile }) as any),
    });

    await expect(
      handlers.readFile.call(
        {
          subject:
            "fs-viewer-test.project-00000000-0000-4000-8000-000000000000.account-11111111-1111-4111-8111-111111111111",
        },
        "/home/user/a.txt",
        "utf8",
        1000,
      ),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(readFile).not.toHaveBeenCalled();

    await expect(
      handlers.readFile.call(
        {
          subject:
            "fs-viewer-test.project-00000000-0000-4000-8000-000000000000.account-11111111-1111-4111-8111-111111111111",
        },
        "/home/user/a.txt",
        "utf8",
      ),
    ).resolves.toBe("ok");
    expect(readFile).toHaveBeenCalledWith("/home/user/a.txt", "utf8");

    server.close();
  });

  it("exposes realpath on read-only filesystem service", async () => {
    const { fsReadOnlyServer } = await import("./fs");
    const realpath = jest.fn(async (path: string) => `/resolved${path}`);
    let handlers: any;
    const close = jest.fn();
    const client = {
      service: jest.fn(async (_subject, svc) => {
        handlers = svc;
        return { close };
      }),
    } as any;

    const server = await fsReadOnlyServer({
      service: "fs-viewer-test",
      client,
      fs: jest.fn(async () => ({ realpath }) as any),
    });

    await expect(
      handlers.realpath.call(
        {
          subject:
            "fs-viewer-test.project-00000000-0000-4000-8000-000000000000.account-11111111-1111-4111-8111-111111111111",
        },
        "/home/user/a.txt",
      ),
    ).resolves.toBe("/resolved/home/user/a.txt");
    expect(realpath).toHaveBeenCalledWith("/home/user/a.txt");

    server.close();
  });

  it("exposes getListing on read-only filesystem service", async () => {
    const { fsReadOnlyServer } = await import("./fs");
    const getListing = jest.fn(async () => ({
      files: { "a.txt": { type: "f", size: 1, mtime: 1 } },
    }));
    let handlers: any;
    const close = jest.fn();
    const client = {
      service: jest.fn(async (_subject, svc) => {
        handlers = svc;
        return { close };
      }),
    } as any;

    const server = await fsReadOnlyServer({
      service: "fs-viewer-test",
      client,
      fs: jest.fn(async () => ({ getListing }) as any),
    });

    await expect(
      handlers.getListing.call(
        {
          subject:
            "fs-viewer-test.project-00000000-0000-4000-8000-000000000000.account-11111111-1111-4111-8111-111111111111",
        },
        "/home/user",
      ),
    ).resolves.toMatchObject({
      files: { "a.txt": { type: "f" } },
    });
    expect(getListing).toHaveBeenCalledWith("/home/user");

    server.close();
  });

  it("expires cached read-only filesystem subjects", async () => {
    const { fsReadOnlyServer } = await import("./fs");
    const fs0 = jest.fn(async () => ({
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

    const subject =
      "fs-viewer-test.project-00000000-0000-4000-8000-000000000000.account-11111111-1111-4111-8111-111111111111";
    const server = await fsReadOnlyServer({
      service: "fs-viewer-test",
      client,
      fs: fs0 as any,
      cacheTtlMs: 1,
    });

    await handlers.readFile.call({ subject }, "/home/user/a.txt", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handlers.readFile.call({ subject }, "/home/user/a.txt", "utf8");

    expect(fs0).toHaveBeenCalledTimes(2);
    server.close();
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
