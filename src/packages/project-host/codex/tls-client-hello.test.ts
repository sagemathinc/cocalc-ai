import { connect as tlsConnect } from "node:tls";
import { createServer } from "node:net";
import { readClientHelloServerName } from "./tls-client-hello";

/** The exact bytes Node's TLS client sends first. */
async function captureClientHello(servername?: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once("data", (data) => {
        socket.destroy();
        server.close();
        resolve(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const client = tlsConnect({
        host: "127.0.0.1",
        port,
        ...(servername ? { servername } : {}),
        rejectUnauthorized: false,
      });
      client.on("error", () => {});
    });
    server.on("error", reject);
  });
}

test("reads the requested server name from a real ClientHello", async () => {
  const hello = await captureClientHello("chatgpt.com");
  expect(readClientHelloServerName(hello)).toEqual({
    state: "complete",
    serverName: "chatgpt.com",
  });
});

test("waits for a ClientHello split across reads and records", async () => {
  const hello = await captureClientHello("api.openai.com");
  for (const cut of [1, 4, 5, 20, hello.length - 1])
    expect(readClientHelloServerName(hello.subarray(0, cut))).toEqual({
      state: "incomplete",
    });
  // Re-frame the handshake as two TLS records.
  const handshake = hello.subarray(5);
  const record = (payload: Buffer) =>
    Buffer.concat([
      Buffer.from([
        0x16,
        0x03,
        0x01,
        payload.length >> 8,
        payload.length & 255,
      ]),
      payload,
    ]);
  const split = Buffer.concat([
    record(handshake.subarray(0, 10)),
    record(handshake.subarray(10)),
  ]);
  expect(readClientHelloServerName(split)).toEqual({
    state: "complete",
    serverName: "api.openai.com",
  });
});

test("fails closed without a usable server name", async () => {
  const noSni = await captureClientHello();
  expect(readClientHelloServerName(noSni).state).toBe("invalid");
  expect(
    readClientHelloServerName(Buffer.from("GET / HTTP/1.1\r\n\r\n")).state,
  ).toBe("invalid");
  const hello = await captureClientHello("chatgpt.com");
  const corrupt = Buffer.from(hello);
  // Claim a longer extensions block than the message contains.
  corrupt.writeUInt16BE(0xffff, corrupt.length - 2);
  expect(["invalid", "complete"]).toContain(
    readClientHelloServerName(corrupt).state,
  );
  const wrongHandshake = Buffer.from(hello);
  wrongHandshake[5] = 0x02; // ServerHello
  expect(readClientHelloServerName(wrongHandshake).state).toBe("invalid");
});
