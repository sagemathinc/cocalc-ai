/** @jest-environment jsdom */

import { AkvDraftAdapter } from "../akv-adapter";

describe("AkvDraftAdapter", () => {
  it("loads valid versioned payloads", async () => {
    const kv = {
      get: jest.fn(async () => ({
        version: 1,
        text: "hello",
        updatedAt: 42,
        composing: true,
      })),
      set: jest.fn(async () => {}),
      delete: jest.fn(async () => {}),
    };
    const adapter = new AkvDraftAdapter({ kv });
    await expect(adapter.load("k")).resolves.toEqual({
      text: "hello",
      updatedAt: 42,
      composing: true,
    });
  });

  it("ignores unknown payload shapes", async () => {
    const kv = {
      get: jest.fn(async () => ({ text: "legacy" })),
      set: jest.fn(async () => {}),
      delete: jest.fn(async () => {}),
    };
    const adapter = new AkvDraftAdapter({ kv });
    await expect(adapter.load("k")).resolves.toBeUndefined();
  });

  it("writes ttl when provided", async () => {
    const kv = {
      get: jest.fn(async () => undefined),
      set: jest.fn(async () => {}),
      delete: jest.fn(async () => {}),
    };
    const adapter = new AkvDraftAdapter({ kv, defaultTtlMs: 9000 });
    await adapter.save(
      "k",
      { text: "x", updatedAt: 1, composing: false },
      { ttlMs: 1000 },
    );
    expect(kv.set).toHaveBeenCalledWith(
      "k",
      expect.objectContaining({ version: 1, text: "x", updatedAt: 1 }),
      { ttl: 1000 },
    );
  });

  it("falls back to default ttl when call ttl is missing", async () => {
    const kv = {
      get: jest.fn(async () => undefined),
      set: jest.fn(async () => {}),
      delete: jest.fn(async () => {}),
    };
    const adapter = new AkvDraftAdapter({ kv, defaultTtlMs: 9000 });
    await adapter.save("k", { text: "x", updatedAt: 1, composing: false });
    expect(kv.set).toHaveBeenCalledWith(
      "k",
      expect.objectContaining({ version: 1, text: "x", updatedAt: 1 }),
      { ttl: 9000 },
    );
  });
});
