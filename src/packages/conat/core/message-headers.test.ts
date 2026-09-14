import {
  MAX_MESSAGE_HEADER_BYTES,
  validateMessageHeaders,
} from "./message-headers";
import { Message } from "./client";
import { DataEncoding } from "./codec";
import {
  FILE_READ_PRINCIPAL_HEADER,
  stampFileReadPrincipal,
} from "../files/read-principal";

describe("bounded JSON message headers", () => {
  it.each(["text", [], Buffer.alloc(8), new Uint8Array(8), 1, true])(
    "rejects non-record headers before stamping (%p)",
    (headers) => {
      const data = ["id", 0, 1, 0, Buffer.alloc(0), headers];
      expect(() =>
        stampFileReadPrincipal({
          subject: "project.example.files:read.service",
          data,
          user: { account_id: "alice" },
          trusted: false,
        }),
      ).toThrow(expect.objectContaining({ code: 400 }));
      expect(data[5]).toBe(headers);
    },
  );

  it("accepts absent headers, null placeholders, and bounded JSON records", () => {
    for (const headers of [
      undefined,
      null,
      Object.create(null),
      { nested: { values: [true, false, null, 1.25, "value"] } },
    ])
      expect(() => validateMessageHeaders(headers)).not.toThrow();
  });

  it("bounds serialized bytes including escaping and UTF-8", () => {
    const fits = { value: "x".repeat(MAX_MESSAGE_HEADER_BYTES - 12) };
    expect(Buffer.byteLength(JSON.stringify(fits))).toBe(
      MAX_MESSAGE_HEADER_BYTES,
    );
    expect(() => validateMessageHeaders(fits)).not.toThrow();
    expect(() => validateMessageHeaders({ value: fits.value + "x" })).toThrow(
      "byte limit",
    );
    for (const value of ["\u20ac", "\u0000"]) {
      expect(() =>
        validateMessageHeaders({
          value: value.repeat(MAX_MESSAGE_HEADER_BYTES / 2),
        }),
      ).toThrow("byte limit");
    }
  });

  it("accepts wide metadata and deeply nested JSON within the byte budget", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`k${i}`, 0]),
    );
    expect(() => validateMessageHeaders(headers)).not.toThrow();
    expect(() =>
      validateMessageHeaders({
        values: Array(1000).fill(0),
      }),
    ).not.toThrow();
    let nested: unknown = 0;
    // Deeper than ordinary JS recursion; this must not overflow the call stack.
    for (let i = 0; i < 10_000; i++) nested = [nested];
    expect(() => validateMessageHeaders({ nested })).not.toThrow();
  });

  it("rejects cycles and accessors but permits shared JSON subobjects", () => {
    const cycle: any = {};
    cycle.child = cycle;
    expect(() => validateMessageHeaders(cycle)).toThrow("cyclic");
    const shared = { key: "value" };
    expect(() =>
      validateMessageHeaders({ a: shared, b: shared }),
    ).not.toThrow();
    const get = jest.fn();
    const accessor = Object.defineProperty({}, "value", {
      get,
      enumerable: true,
    });
    expect(() => validateMessageHeaders(accessor)).toThrow("accessors");
    expect(get).not.toHaveBeenCalled();
  });

  it("matches JSON byte accounting for nested arrays, keys, and omitted fields", () => {
    const variants = [
      {
        metadata: {
          users: Array(200).fill("editor"),
          settings: { nested: [{ key: "value" }] },
        },
      },
      {
        checkpoints: { latest: { seq: 1, time: 2, data: undefined } },
        array: [undefined, null, false, -1.25],
      },
      { "\u20ac\u0000": ["\u20ac\u0000", { blank: "", more: [] }], empty: {} },
    ];
    for (const variant of variants) {
      const headers = { ...variant, padding: "" };
      headers.padding = "x".repeat(
        MAX_MESSAGE_HEADER_BYTES - Buffer.byteLength(JSON.stringify(headers)),
      );
      expect(Buffer.byteLength(JSON.stringify(headers))).toBe(
        MAX_MESSAGE_HEADER_BYTES,
      );
      expect(() => validateMessageHeaders(headers)).not.toThrow();
      headers.padding += "x";
      expect(() => validateMessageHeaders(headers)).toThrow("byte limit");
    }
  });

  it("stamps in place and accounts for the added field", () => {
    const headers = {
      "CN-Reply": "INBOX.valid",
      [FILE_READ_PRINCIPAL_HEADER]: "account:other",
    };
    const data = ["id", 0, 1, 0, Buffer.alloc(0), headers];
    stampFileReadPrincipal({
      subject: "project.example.files:read.service",
      data,
      user: { account_id: "alice" },
      trusted: false,
    });
    expect(data[5]).toBe(headers);
    expect(headers[FILE_READ_PRINCIPAL_HEADER]).toBe("account:alice");
    data[5] = { padding: "x".repeat(MAX_MESSAGE_HEADER_BYTES - 14) };
    expect(() =>
      stampFileReadPrincipal({
        subject: "project.example.files:read.service",
        data,
        user: { account_id: "alice" },
        trusted: false,
      }),
    ).toThrow("byte limit");
  });

  it.each([null, 3, [], {}, "", "a.*", "a.>", "a..b", "a b"])(
    "rejects an invalid reply header without coercion (%p)",
    (reply) => {
      expect(() => validateMessageHeaders({ "CN-Reply": reply })).toThrow(
        "CN-Reply",
      );
      if (reply == null) return;
      const publishSync = jest.fn();
      const message = new Message({
        subject: "service",
        encoding: DataEncoding.JsonCodec,
        raw: Buffer.from("null"),
        headers: { "CN-Reply": reply },
        client: { publishSync },
      });
      expect(() => message.respondSync(null)).toThrow("CN-Reply");
      expect(publishSync).not.toHaveBeenCalled();
    },
  );
});
