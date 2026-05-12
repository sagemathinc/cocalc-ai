describe("files read explicit routing", () => {
  it("requires an explicit Conat client for createServer", async () => {
    const { createServer } = await import("./read");

    await expect(
      createServer({
        project_id: "00000000-1000-4000-8000-000000000000",
        createReadStream: () => null,
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("requires an explicit Conat client for readFile", async () => {
    const { readFile } = await import("./read");

    const iterator = readFile({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/test",
    });
    await expect(iterator.next()).rejects.toThrow(
      "must provide an explicit Conat client",
    );
  });

  it("rejects reads above the active stream cap", async () => {
    const { close, createServer } = await import("./read");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const respond1 = jest.fn(async () => ({ count: 1 }));
    const respond2 = jest.fn();
    const subject = "project-1";
    const subscription = {
      async *[Symbol.asyncIterator]() {
        yield {
          subject,
          data: { path: "/tmp/first" },
          respond: respond1,
          respondSync: respond1,
        };
        yield {
          subject,
          data: { path: "/tmp/second" },
          respond: respond2,
          respondSync: respond2,
        };
      },
      drain: jest.fn(),
    };
    const client = {
      subscribe: jest.fn(async () => subscription),
    };
    const createReadStream = async function* (path: string) {
      if (path === "/tmp/first") {
        await blocked;
      }
      yield Buffer.from("data");
    };

    await createServer({
      client: client as any,
      project_id: "00000000-1000-4000-8000-000000000001",
      createReadStream,
      maxActiveStreams: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(respond2).toHaveBeenCalledWith(null, {
      headers: { error: "project file read service is busy" },
    });

    release();
    await new Promise((resolve) => setImmediate(resolve));
    await close({ project_id: "00000000-1000-4000-8000-000000000001" });
  });
});
