import net from "node:net";
import { chooseLitePort, ensureLitePort } from "./start";

function listen(port: number, host = "localhost"): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function serverPort(server: net.Server): number {
  const address = server.address();
  if (typeof address !== "object" || address == null) {
    throw new Error("server has no TCP address");
  }
  return address.port;
}

describe("cocalc-plus Lite port selection", () => {
  const originalPort = process.env.PORT;
  const originalHost = process.env.HOST;

  afterEach(() => {
    if (originalPort == null) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalHost == null) delete process.env.HOST;
    else process.env.HOST = originalHost;
  });

  it("falls back to a free port when the preferred port is occupied", async () => {
    const server = await listen(0);
    try {
      const occupiedPort = serverPort(server);
      const selectedPort = await chooseLitePort({
        preferredPort: occupiedPort,
      });

      expect(selectedPort).not.toBe(occupiedPort);

      const selectedServer = await listen(selectedPort);
      await close(selectedServer);
    } finally {
      await close(server);
    }
  });

  it("treats localhost as occupied when the IPv6 loopback port is occupied", async () => {
    let server: net.Server;
    try {
      server = await listen(0, "::1");
    } catch (err: any) {
      if (err?.code === "EAFNOSUPPORT" || err?.code === "EINVAL") {
        return;
      }
      throw err;
    }
    try {
      const occupiedPort = serverPort(server);
      const selectedPort = await chooseLitePort({
        preferredPort: occupiedPort,
        host: "localhost",
      });

      expect(selectedPort).not.toBe(occupiedPort);
    } finally {
      await close(server);
    }
  });

  it("does not override an explicit PORT", async () => {
    process.env.PORT = "61234";

    await ensureLitePort();

    expect(process.env.PORT).toBe("61234");
  });
});
