/*
DEVELOPMENT:

pnpm test ./get-address.test.ts
*/

import { getAddress } from "./server";

function makeSocket({
  address,
  headers,
}: {
  address: string;
  headers?: Record<string, any>;
}) {
  return {
    handshake: {
      address,
      headers: headers ?? {},
    },
  };
}

describe("getAddress", () => {
  it("uses forwarded headers in legacy mode", () => {
    const socket = makeSocket({
      address: "198.51.100.8",
      headers: {
        "x-forwarded-for": "203.0.113.10, 127.0.0.1",
      },
    });
    expect(getAddress(socket)).toBe("203.0.113.10");
  });

  it("ignores forwarded headers in strict mode when peer is untrusted", () => {
    const socket = makeSocket({
      address: "198.51.100.8",
      headers: {
        "cf-connecting-ip": "203.0.113.10",
        "x-forwarded-for": "203.0.113.10, 127.0.0.1",
      },
    });
    expect(getAddress(socket, { strictCloudflareProxy: true })).toBe(
      "198.51.100.8",
    );
  });

  it("accepts cf-connecting-ip in strict mode when peer is trusted loopback", () => {
    const socket = makeSocket({
      address: "::ffff:127.0.0.1",
      headers: {
        "cf-connecting-ip": "203.0.113.44",
      },
    });
    expect(getAddress(socket, { strictCloudflareProxy: true })).toBe(
      "203.0.113.44",
    );
  });

  it("falls back to normalized peer address", () => {
    const socket = makeSocket({
      address: "::ffff:127.0.0.1",
    });
    expect(getAddress(socket, { strictCloudflareProxy: true })).toBe(
      "127.0.0.1",
    );
  });
});

