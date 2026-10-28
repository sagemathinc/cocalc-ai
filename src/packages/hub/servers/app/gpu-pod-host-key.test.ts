import type { AddressInfo } from "node:net";
import express from "express";
import { newHostkeyToken } from "@cocalc/server/gpu/hostkey-token";
import initGpuPodHostKey from "./gpu-pod-host-key";

function key(fill: number): string {
  const part = (b: Buffer) => {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, b]);
  };
  return `ssh-ed25519 ${Buffer.concat([part(Buffer.from("ssh-ed25519")), part(Buffer.alloc(32, fill))]).toString("base64")}`;
}
const HOST_KEY = key(1);

// The same secret bytes with one of the 2 unused final bits set.
const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function nonCanonical(token: string): string {
  const last = token.slice(-1);
  return token.slice(0, -1) + B64URL[B64URL.indexOf(last) ^ 1];
}

describe("POST /gpu/pod-host-key", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let url: string;
  let register: jest.Mock;
  let forward: jest.Mock;
  let secure = true;
  const here = newHostkeyToken("bay-0");
  const there = newHostkeyToken("bay-1");

  beforeEach(async () => {
    secure = true;
    register = jest.fn(async () => ({ status: 200, result: "registered" }));
    forward = jest.fn(async () => ({ status: 200, result: "registered" }));
    const app = express();
    const router = express.Router();
    initGpuPodHostKey(router, {
      isSecure: () => secure,
      knownBays: () => new Set(["bay-0", "bay-1"]),
      thisBay: () => "bay-0",
      register,
      forward,
    });
    app.use("/base", router);
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/base/gpu/pod-host-key`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const post = (
    body: unknown,
    headers: Record<string, string> = {},
    token = here.token,
  ) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const good = { pod_id: "pod_abc123", host_public_key: HOST_KEY };

  it("registers here, or forwards whole to the token's authority bay", async () => {
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "registered" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(register).toHaveBeenCalledWith({
      token: {
        authority_bay_id: "bay-0",
        token_id: here.token_id,
        secret: here.secret,
      },
      ...good,
    });
    expect((await post(good, {}, there.token)).status).toBe(200);
    expect(forward).toHaveBeenCalledWith(
      "bay-1",
      expect.objectContaining(good),
    );
  });

  it("passes the authority bay's answer through as a fixed word", async () => {
    register.mockResolvedValueOnce({ status: 409, result: "not_bound" });
    const res = await post(good);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ result: "not_bound" });
    register.mockRejectedValueOnce(new Error(`db said ${here.secret}`));
    const failed = await post(good);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain(here.secret);
  });

  it.each([
    ["GET", () => fetch(url), 405],
    ["plain HTTP", () => ((secure = false), post(good)), 400],
    [
      "no token",
      () =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(good),
        }),
      401,
    ],
    [
      "a lowercase scheme",
      () => post(good, { Authorization: `bearer ${here.token}` }),
      401,
    ],
    [
      "a non-canonical token (an unused final bit set)",
      () => post(good, {}, nonCanonical(here.token)),
      401,
    ],
    [
      "an unknown bay",
      () => post(good, {}, newHostkeyToken("bay-9").token),
      401,
    ],
    [
      "no JSON content type",
      () => post(good, { "Content-Type": "text/plain" }),
      415,
    ],
    ["a body over 2 KB", () => post({ ...good, pad: "x".repeat(3000) }), 400],
    ["malformed JSON", () => post("{nope"), 400],
    ["an extra field", () => post({ ...good, extra: 1 }), 400],
    ["a bad pod id", () => post({ ...good, pod_id: "../x" }), 400],
    [
      "a bad key",
      () => post({ ...good, host_public_key: `ssh-ed25519 ${"A".repeat(68)}` }),
      400,
    ],
  ])(
    "refuses %s without a lookup or a forward",
    async (_name, send, status) => {
      const res = await (send as () => Promise<Response>)();
      expect(res.status).toBe(status);
      expect(register).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    },
  );

  it("rate-limits one token", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post(good)).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});
