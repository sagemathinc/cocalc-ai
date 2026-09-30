/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedClaudeSubscriptionFiles,
  claudeSubscriptionBundleFiles,
  packClaudeSubscriptionBundle,
  readClaudeSubscriptionHomeFiles,
  restoreClaudeSubscriptionHome,
} from "./claude-subscription-home";
import { syncClaudeSubscriptionCredential } from "./claude-subscription-registry";
import {
  ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY,
  ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY,
  CLAUDE_SUBSCRIPTION_PROFILE_ID,
} from "@cocalc/util/ai/external-credential-profiles";
import { EXTERNAL_CREDENTIAL_CONFLICT } from "@cocalc/util/external-credential-conflict";

// An in-memory stand-in for the account credential registry, with the same
// compare-and-swap semantics as the hub.
let stored: string;
let upserts = 0;
let beforeUpsert: (() => Promise<void>) | undefined;
let afterCommit: (() => void) | undefined;
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const mockCallHub = jest.fn(async ({ name, args }) => {
  if (name === "hosts.getExternalCredential")
    return {
      id: credentialId,
      payload: stored,
      metadata: {
        [ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY]:
          CLAUDE_SUBSCRIPTION_PROFILE_ID,
        [ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY]: "user@example.com",
        plan: "Claude Max",
      },
    };
  if (name === "hosts.upsertExternalCredential") {
    const hold = beforeUpsert;
    beforeUpsert = undefined;
    await hold?.();
    const { payload, expected_payload_sha256 } = args[0];
    if (expected_payload_sha256 && expected_payload_sha256 !== sha256(stored))
      throw Error(EXTERNAL_CREDENTIAL_CONFLICT);
    stored = payload;
    upserts++;
    const lost = afterCommit;
    afterCommit = undefined;
    lost?.();
    return { id: credentialId };
  }
  throw Error(`unexpected hub call ${name}`);
});
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (options) => mockCallHub(options),
}));
jest.mock("../master-conat-client", () => ({
  getMasterConatClient: () => ({}),
}));
jest.mock("../sqlite/hosts", () => ({ getLocalHostId: () => "host" }));

const projectId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const credentialId = "00000000-0000-4000-8000-000000000003";

const bundle = (files: Record<string, string>) =>
  packClaudeSubscriptionBundle(
    new Map(
      Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]),
    ),
  );
const text = (payload: string) =>
  Object.fromEntries(
    [...claudeSubscriptionBundleFiles(payload)].map(([path, bytes]) => [
      path,
      bytes.toString(),
    ]),
  );

const homes: string[] = [];

/** A controller: a private home restored from the stored bundle. */
async function controller() {
  const home = await mkdtemp(join(tmpdir(), "claude-sync-test-"));
  homes.push(home);
  await restoreClaudeSubscriptionHome(home, stored);
  let baseline: ReadonlyMap<string, Buffer> =
    claudeSubscriptionBundleFiles(stored);
  const paths = [...baseline.keys()];
  return {
    home,
    write: (path: string, value: string) => writeFile(join(home, path), value),
    sync: async () => {
      baseline = await syncClaudeSubscriptionCredential({
        projectId,
        accountId,
        credentialId,
        baseline,
        current: await readClaudeSubscriptionHomeFiles(home, paths),
      });
    },
  };
}

beforeEach(() => {
  upserts = 0;
  beforeUpsert = undefined;
  afterCommit = undefined;
  mockCallHub.mockClear();
  stored = bundle({
    ".credentials.json": "refresh-token-1",
    ".claude.json": "settings-old",
  });
});

afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

test("an unchanged controller saves nothing", async () => {
  const a = await controller();
  await a.sync();
  expect(mockCallHub).not.toHaveBeenCalled();
});

test("a settings-only write that read before a token rotation cannot restore the old token", async () => {
  const a = await controller();
  const b = await controller();
  await a.write(".credentials.json", "refresh-token-2");
  await b.write(".claude.json", "settings-new");
  // B reads the stored bundle, then is held before writing until A has saved
  // its rotated token.
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => (reached = resolve));
  beforeUpsert = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      reached();
    });
  const bSync = b.sync();
  await held;
  await a.sync();
  release();
  await bSync;
  expect(text(stored)).toEqual({
    ".credentials.json": "refresh-token-2",
    ".claude.json": "settings-new",
  });
});

test("a write whose acknowledgement was lost is never replayed over newer bytes", async () => {
  const b = await controller();
  await b.write(".credentials.json", "refresh-token-2");
  afterCommit = () => {
    throw Error("timeout");
  };
  // The write commits but B does not learn it and keeps its old baseline.
  await expect(b.sync()).rejects.toThrow("timeout");
  expect(text(stored)[".credentials.json"]).toBe("refresh-token-2");
  // Another controller then rotates again.
  const a = await controller();
  await a.write(".credentials.json", "refresh-token-3");
  await a.sync();
  // B's next sync must not put token 2 back.
  await b.sync();
  expect(text(stored)[".credentials.json"]).toBe("refresh-token-3");
});

test("a newer stored file on the same path wins over a stale local change", async () => {
  const a = await controller();
  const b = await controller();
  await a.write(".credentials.json", "refresh-token-2");
  await a.sync();
  // B's refresh failed against the rotated token but it rewrote the file.
  await b.write(".credentials.json", "refresh-token-1-rewritten");
  await b.sync();
  expect(text(stored)[".credentials.json"]).toBe("refresh-token-2");
  expect(upserts).toBe(1);
});

describe("reading a live controller home", () => {
  let home: string;
  let outside: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-home-read-"));
    outside = await mkdtemp(join(tmpdir(), "claude-outside-"));
    homes.push(home, outside);
    await writeFile(join(outside, "marker"), "outside-secret");
    await writeFile(join(home, ".claude.json"), "{}");
  });

  test("reads exactly the requested regular files", async () => {
    await mkdir(join(home, "sub"));
    await writeFile(join(home, "sub", "b"), "b");
    const files = await readClaudeSubscriptionHomeFiles(home, [
      ".claude.json",
      "sub/b",
    ]);
    expect([...files].map(([path, bytes]) => [path, `${bytes}`])).toEqual([
      [".claude.json", "{}"],
      ["sub/b", "b"],
    ]);
  });

  test("never follows a symlink leaf or parent out of the home", async () => {
    await symlink(join(outside, "marker"), join(home, ".credentials.json"));
    await expect(
      readClaudeSubscriptionHomeFiles(home, [".credentials.json"]),
    ).rejects.toThrow("unsupported entry");
    await symlink(outside, join(home, "dir"));
    await expect(
      readClaudeSubscriptionHomeFiles(home, ["dir/marker"]),
    ).rejects.toThrow("unsupported entry");
  });

  test("a FIFO cannot hang the host", async () => {
    execFileSync("mkfifo", [join(home, "pipe")]);
    const started = Date.now();
    await expect(
      readClaudeSubscriptionHomeFiles(home, ["pipe"], { timeoutMs: 1000 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("an oversized file is refused without reading it all", async () => {
    await writeFile(join(home, "big"), Buffer.alloc(1024 * 1024 + 1));
    await expect(
      readClaudeSubscriptionHomeFiles(home, ["big"]),
    ).rejects.toThrow();
  });

  test("rejects paths outside the bundle's shape", async () => {
    await expect(
      readClaudeSubscriptionHomeFiles(home, ["../escape"]),
    ).rejects.toThrow("Invalid Claude auth path");
  });
});

test("bundle helpers round-trip and compare opaque bytes", () => {
  const before = claudeSubscriptionBundleFiles(
    bundle({ a: "1", "dir/b": "2" }),
  );
  const after = claudeSubscriptionBundleFiles(bundle({ a: "1", "dir/b": "3" }));
  expect([...changedClaudeSubscriptionFiles(before, after).keys()]).toEqual([
    "dir/b",
  ]);
  expect(changedClaudeSubscriptionFiles(before, before).size).toBe(0);
  expect(() =>
    packClaudeSubscriptionBundle(new Map([["../escape", Buffer.from("x")]])),
  ).toThrow("Invalid Claude auth path");
  expect(() =>
    claudeSubscriptionBundleFiles(
      JSON.stringify({ version: 1, files: [{ path: "a", content: "!!" }] }),
    ),
  ).toThrow("Invalid Claude auth bundle entry");
});

test("a maximal bundle with long paths still fits the reader's output cap", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-home-long-"));
  homes.push(home);
  // 128 files with ~990-character paths and 1.4 MB of data in total.
  const segment = "d".repeat(200);
  const dir = [segment, segment, segment, segment].join("/");
  await mkdir(join(home, dir), { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < 128; i++) {
    const path = `${dir}/${String(i).padStart(3, "0")}${"f".repeat(180)}`;
    await writeFile(join(home, path), Buffer.alloc(10_937, i));
    paths.push(path);
  }
  const files = await readClaudeSubscriptionHomeFiles(home, paths);
  expect(files.size).toBe(128);
});
