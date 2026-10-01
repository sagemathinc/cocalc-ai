import {
  AGENT_MEMORY_LIMITS,
  agentMemoryIndex,
  detectSecret,
  parseAgentMemoryRecord,
  validateAgentMemoryRequest,
  validateMemoryWrite,
} from "./memory";

const note = (name: string) => ({
  name,
  description: "d",
  body: "b",
  updated_at: "2026-10-01T00:00:00.000Z",
});

test("validates writes with byte-counted limits and no control characters", () => {
  expect(
    validateMemoryWrite({ name: "ok-1", description: " d ", body: " b " }),
  ).toEqual({ name: "ok-1", description: "d", body: "b" });
  expect(() =>
    validateMemoryWrite({ name: "Bad", description: "d", body: "b" }),
  ).toThrow(/lowercase/);
  expect(() =>
    validateMemoryWrite({ name: "ok", description: "a\nb", body: "b" }),
  ).toThrow(/one line/);
  expect(() =>
    validateMemoryWrite({ name: "ok", description: "d", body: "a\u0007b" }),
  ).toThrow(/control/);
  expect(() =>
    validateMemoryWrite({ name: "ok", description: "d", body: "x‮y" }),
  ).toThrow(/control/);
  // 4-byte characters count as bytes, not JavaScript characters.
  expect(() =>
    validateMemoryWrite({
      name: "ok",
      description: "😀".repeat(51),
      body: "b",
    }),
  ).toThrow(/200 bytes/);
});

test.each([
  ["-----BEGIN OPENSSH PRIVATE KEY-----", "a private key"],
  ["token ghp_" + "a".repeat(36), "a GitHub token"],
  ["key sk-ant-" + "a".repeat(30), "an API key"],
  ["AKIAABCDEFGHIJKLMNOP", "an AWS access key"],
  ["Authorization: Bearer abcdefghijkl", "an authorization header"],
  ["password = hunter22", "a password or key assignment"],
])("rejects likely secrets: %s", (text, label) => {
  expect(detectSecret(text)).toBe(label);
  expect(() =>
    validateMemoryWrite({ name: "x", description: "d", body: text }),
  ).toThrow(/must not contain secrets/);
});

test("does not flag ordinary notes", () => {
  expect(
    detectSecret(
      "Run upgrade-all.sh in a project terminal; never pipe git push -q through grep.",
    ),
  ).toBeUndefined();
});

test("strict parse fails closed on malformed or oversized records", () => {
  expect(parseAgentMemoryRecord(undefined)).toEqual({
    version: 1,
    enabled: false,
    notes: [],
  });
  const good = { version: 1, enabled: true, notes: [note("a")] };
  expect(parseAgentMemoryRecord(JSON.stringify(good)).notes).toHaveLength(1);
  for (const bad of [
    "not json",
    JSON.stringify({ version: 2, enabled: true, notes: [] }),
    JSON.stringify({ ...good, notes: [note("a"), note("a")] }),
    JSON.stringify({ ...good, notes: [{ ...note("a"), updated_at: "x" }] }),
    JSON.stringify({ ...good, notes: [{ ...note("A") }] }),
    "x".repeat(AGENT_MEMORY_LIMITS.maxRecordBytes + 1),
  ])
    expect(() => parseAgentMemoryRecord(bad)).toThrow();
});

test("index is bounded in bytes and sorted", () => {
  const notes = Array.from({ length: 300 }, (_, i) => ({
    ...note(`n-${String(i).padStart(3, "0")}`),
    description: "é".repeat(90),
  }));
  const index = agentMemoryIndex(notes);
  expect(new TextEncoder().encode(index).length).toBeLessThan(
    AGENT_MEMORY_LIMITS.maxIndexBytes + 100,
  );
  expect(index.startsWith("- n-000:")).toBe(true);
  expect(index).toMatch(/more; list them to see all/);
});

test("requests reject unknown fields and operations", () => {
  expect(() =>
    validateAgentMemoryRequest({ action: "memory", op: "list", extra: 1 }),
  ).toThrow(/unknown/);
  expect(() =>
    validateAgentMemoryRequest({ action: "memory", op: "enable" }),
  ).toThrow(/unsupported/);
});

test("migrates withdrawn v1 records as disabled, keeping only valid notes", () => {
  const legacy = JSON.stringify({
    version: 1,
    entries: [
      {
        name: "deploy",
        description: "How to deploy",
        body: "Use a terminal.",
        updated_at: "2026-10-01T06:00:00.000Z",
      },
      {
        name: "deploy",
        description: "dup",
        body: "dup",
        updated_at: "2026-10-01T06:00:00.000Z",
      },
      { name: "Bad Name", description: "x", body: "y", updated_at: "" },
      {
        name: "token",
        description: "t",
        body: "ghp_" + "a".repeat(36),
        updated_at: "",
      },
    ],
  });
  expect(parseAgentMemoryRecord(legacy)).toEqual({
    version: 1,
    enabled: false,
    notes: [
      {
        name: "deploy",
        description: "How to deploy",
        body: "Use a terminal.",
        updated_at: "2026-10-01T06:00:00.000Z",
      },
    ],
  });
});

test("rejects line and paragraph separators", () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  expect(() =>
    validateMemoryWrite({
      name: "ok",
      description: `a${lineSeparator}b`,
      body: "b",
    }),
  ).toThrow(/one line/);
  expect(() =>
    validateMemoryWrite({
      name: "ok",
      description: "d",
      body: `a${paragraphSeparator}b`,
    }),
  ).toThrow(/control/);
});

test("the index never exceeds its byte cap, truncation marker included", () => {
  const notes = Array.from({ length: 2000 }, (_, i) => ({
    ...note(`n-${String(i).padStart(4, "0")}`),
    description: "x".repeat(150),
  }));
  expect(
    new TextEncoder().encode(agentMemoryIndex(notes)).length,
  ).toBeLessThanOrEqual(AGENT_MEMORY_LIMITS.maxIndexBytes);
});
