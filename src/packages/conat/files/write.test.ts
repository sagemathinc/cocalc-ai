describe("files write explicit routing", () => {
  it("requires an explicit Conat client for createServer", async () => {
    const { createServer } = await import("./write");

    await expect(
      createServer({
        project_id: "00000000-1000-4000-8000-000000000000",
        createWriteStream: () => null,
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("requires an explicit Conat client for writeFile", async () => {
    const { writeFile } = await import("./write");
    const stream = {
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from("test");
      },
    };

    await expect(
      writeFile({
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/test",
        stream,
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("rejects writes above the active stream cap", async () => {
    const { close, createServer } = await import("./write");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const respond1 = jest.fn();
    const respond2 = jest.fn();
    const subscription = {
      async *[Symbol.asyncIterator]() {
        yield {
          subject: "project-1",
          data: { path: "/tmp/first", name: "first" },
          respondSync: respond1,
        };
        yield {
          subject: "project-1",
          data: { path: "/tmp/second", name: "second" },
          respondSync: respond2,
        };
      },
      drain: jest.fn(),
    };
    const client = {
      subscribe: jest.fn(async () => subscription),
    };
    const createWriteStream = jest.fn(async (path: string) => {
      if (path === "/tmp/first") {
        await blocked;
      }
      return {
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        emit: jest.fn(),
      };
    });

    await createServer({
      client: client as any,
      project_id: "00000000-1000-4000-8000-000000000002",
      createWriteStream,
      maxActiveStreams: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(createWriteStream).toHaveBeenCalledTimes(1);
    expect(respond2).toHaveBeenCalledWith({
      error: "project file write service is busy",
      status: "error",
    });

    release();
    await new Promise((resolve) => setImmediate(resolve));
    await close({ project_id: "00000000-1000-4000-8000-000000000002" });
  });
});
