import { Client, ConatError, connect } from "../core/client";
import { ConatServer, init } from "../core/server";
import { fsClient, fsServer } from "./fs";

const project_id = "00000000-0000-4000-8000-000000000001";
const subject = `fs.project-${project_id}`;

describe("filesystem write receipt RPCs", () => {
  let filesystem: Awaited<ReturnType<typeof fsServer>>;
  afterEach(async () => {
    filesystem?.close();
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  async function fixture() {
    let allowed = true;
    const writeFile = jest.fn(async (..._args: any[]) => {});
    const server = init({
      port: 0,
      getUser: async (socket) => {
        const auth = socket.handshake.auth;
        if (auth.service) return { hub_id: "service" };
        return {
          account_id: "account",
          auth_api_key: {
            account_id: "account",
            key_id: auth.key ?? "key",
            scope_revision: auth.revision ?? 1,
            project_id,
            placement_revision: 0,
            capabilities: ["file:write"],
            subjects: [subject],
            reply_prefix: auth.reply ?? "_INBOX.first",
          },
        };
      },
      isAllowed: async ({ user, type, subject: target }) =>
        !!user.hub_id || type !== "pub" || target !== subject || allowed,
    });
    const service = connect({
      address: server.address(),
      noCache: true,
      auth: { service: true },
    });
    await service.waitUntilSignedIn({ timeout: 5000 });
    filesystem = await fsServer({
      service: "fs",
      project_id,
      client: service,
      fs: async () => ({ writeFile }) as any,
      jupyter: {
        importIpynb: async () => ({ ipynb: {} }),
        saveIpynb: async () => ({ ipynb: {}, bytes: 0, converted: false }),
      },
    });
    const client = async (
      auth = {},
      fault?: "write" | "reserve" | "unknown" | "authority",
    ) => {
      const connection = connect({
        address: server.address(),
        noCache: true,
        auth,
      });
      await connection.waitUntilSignedIn({ timeout: 5000 });
      if (fault) {
        const call0 = connection.call.bind(connection);
        connection.call = ((...args) => {
          const api = call0(...args);
          const method =
            fault === "reserve" ? "reserveWrite" : "writeFileWithReceipt";
          const original = api[method].bind(api);
          let lose = true;
          api[method] = async (...writeArgs) => {
            const result = await original(...writeArgs);
            if (lose) {
              lose = false;
              if (fault === "authority")
                connection.info!.user!.auth_api_key!.key_id = "changed";
              throw new ConatError("acknowledgment lost", {
                code:
                  fault === "unknown" ? "OUTCOME_UNKNOWN" : "CONNECTION_LOST",
              });
            }
            return result;
          };
          return api;
        }) as typeof connection.call;
      }
      return fsClient({ client: connection, subject, timeout: 2000 });
    };
    return {
      client,
      writeFile,
      revoke: () => {
        allowed = false;
      },
    };
  }

  it("bounds outstanding reservations per authority", async () => {
    const { client, writeFile } = await fixture();
    const api = await client();
    for (let i = 0; i < 32; i++) await api.reserveWrite();
    await expect(api.reserveWrite()).rejects.toMatchObject({ code: 429 });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("requires server-authenticated key metadata even on an authorized service socket", async () => {
    const { client, writeFile } = await fixture();
    const api = await client({ service: true });
    await expect(api.reserveWrite()).rejects.toMatchObject({ code: 403 });
    await expect(api.writeReceiptStatus("fake")).rejects.toMatchObject({
      code: 403,
    });
    await expect(
      api.writeFileWithReceipt("fake", "a", "x"),
    ).rejects.toMatchObject({ code: 403 });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("retains a failed outcome instead of rerunning the filesystem action", async () => {
    const { client, writeFile } = await fixture();
    writeFile.mockRejectedValue(
      new ConatError("read-only volume", { code: "EROFS" }),
    );
    const api = await client();
    const id = await api.reserveWrite();
    for (let i = 0; i < 2; i++)
      await expect(
        api.writeFileWithReceipt(id, "a", "x"),
      ).rejects.toMatchObject({ code: "EROFS" });
    expect(await api.writeReceiptStatus(id)).toBe("failed");
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("recovers an ordinary client write after its successful acknowledgment is lost", async () => {
    const { client, writeFile } = await fixture();
    const api = await client({}, "write");
    await api.writeFile("a.txt", "hello", true);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost reservation acknowledgment before starting a write", async () => {
    const { client, writeFile } = await fixture();
    const api = await client({}, "reserve");
    await api.writeFile("a", "x");
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "authority"] as const)(
    "does not replay after %s recovery failure",
    async (fault) => {
      const { client, writeFile } = await fixture();
      const api = await client({}, fault);
      await expect(api.writeFile("a", "x")).rejects.toMatchObject({
        code: fault === "unknown" ? "OUTCOME_UNKNOWN" : 403,
      });
      expect(writeFile).toHaveBeenCalledTimes(1);
    },
  );

  it("shares a pending mutation between concurrent receipt requests", async () => {
    const { client, writeFile } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    writeFile.mockImplementation(async () => {
      entered();
      await gate;
    });
    const api = await client();
    const id = await api.reserveWrite();
    const first = api.writeFileWithReceipt(id, "a", "x");
    await started;
    const second = api.writeFileWithReceipt(id, "a", "x");
    expect(await api.writeReceiptStatus(id)).toBe("running");
    release();
    await Promise.all([first, second]);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("returns the prior result to a renewed connection without replaying", async () => {
    const { client, writeFile } = await fixture();
    const first = await client();
    const id = await first.reserveWrite();
    await first.writeFileWithReceipt(id, "a.txt", "hello", true);
    const renewed = await client({ reply: "_INBOX.renewed" });
    expect(await renewed.writeReceiptStatus(id)).toBe("succeeded");
    await renewed.writeFileWithReceipt(id, "a.txt", "hello", true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith("a.txt", "hello", true);
  });

  it("does not execute a missing or differently authorized receipt", async () => {
    const { client, writeFile } = await fixture();
    const first = await client();
    const id = await first.reserveWrite();
    for (const auth of [{ key: "other" }, { revision: 2 }]) {
      const other = await client(auth);
      expect(await other.writeReceiptStatus(id)).toBe("unknown");
      await expect(
        other.writeFileWithReceipt(id, "a", "x"),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    }
    await expect(
      first.writeFileWithReceipt("missing", "a", "x"),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rejects changed path, payload, or save policy on an existing receipt", async () => {
    const { client, writeFile } = await fixture();
    const api = await client();
    const id = await api.reserveWrite();
    await api.writeFileWithReceipt(id, "a", "x", true);
    for (const args of [
      ["b", "x", true],
      ["a", "y", true],
      ["a", "x", false],
    ] as const) {
      await expect(api.writeFileWithReceipt(id, ...args)).rejects.toMatchObject(
        { code: 409 },
      );
    }
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("checks current transport authorization for outcome reads and execution", async () => {
    const { client, writeFile, revoke } = await fixture();
    const api = await client();
    const id = await api.reserveWrite();
    revoke();
    await expect(api.writeReceiptStatus(id)).rejects.toMatchObject({
      code: 403,
    });
    await expect(api.writeFileWithReceipt(id, "a", "x")).rejects.toMatchObject({
      code: 403,
    });
    expect(writeFile).not.toHaveBeenCalled();
  });
});
