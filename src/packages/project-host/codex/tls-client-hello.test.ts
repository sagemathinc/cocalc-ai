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

/** Offset of the ClientHello extensions length in a single-record hello. */
function extensionsLengthOffset(hello: Buffer): number {
  let offset = 5 + 4 + 2 + 32;
  offset += 1 + hello[offset];
  offset += 2 + hello.readUInt16BE(offset);
  offset += 1 + hello[offset];
  return offset;
}

test("fails closed without a usable server name", async () => {
  const noSni = await captureClientHello();
  expect(readClientHelloServerName(noSni).state).toBe("invalid");
  expect(
    readClientHelloServerName(Buffer.from("GET / HTTP/1.1\r\n\r\n")).state,
  ).toBe("invalid");
  const hello = await captureClientHello("chatgpt.com");
  const wrongHandshake = Buffer.from(hello);
  wrongHandshake[5] = 0x02; // ServerHello
  expect(readClientHelloServerName(wrongHandshake).state).toBe("invalid");
});

test("an extensions length beyond the message is invalid", async () => {
  const hello = await captureClientHello("chatgpt.com");
  const corrupt = Buffer.from(hello);
  const offset = extensionsLengthOffset(corrupt);
  corrupt.writeUInt16BE(corrupt.readUInt16BE(offset) + 1, offset);
  expect(readClientHelloServerName(corrupt).state).toBe("invalid");
});

test("trailing bytes after the extensions are invalid", async () => {
  const hello = await captureClientHello("chatgpt.com");
  // One extra byte inside the handshake and record, after the extensions.
  const extended = Buffer.concat([hello, Buffer.from([0])]);
  extended.writeUInt16BE(extended.readUInt16BE(3) + 1, 3);
  extended.writeUIntBE(extended.readUIntBE(6, 3) + 1, 6, 3);
  expect(readClientHelloServerName(extended).state).toBe("invalid");
});

test("a server name byte above 0x7f never aliases an ASCII name", async () => {
  const hello = await captureClientHello("chatgpt.com");
  const at = hello.indexOf("chatgpt.com");
  expect(at).toBeGreaterThan(0);
  const aliased = Buffer.from(hello);
  aliased[at] = 0xe3; // "c" | 0x80
  expect(readClientHelloServerName(aliased)).toMatchObject({
    state: "invalid",
  });
});
