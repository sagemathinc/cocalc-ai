import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readNote,
  registerChatMergeApprovalCommands,
} from "./chat-merge-approval";

const ID = "55555555-5555-4555-8555-555555555555";
const HEAD = "c".repeat(40);

function setup(existing: any[] = []) {
  const calls: any[] = [];
  const hubCalls: any[] = [];
  const root = new Command();
  const chat = root.command("project").command("chat");
  registerChatMergeApprovalCommands(chat, {
    withContext: async (_command: any, _name: any, fn: any) =>
      await fn({
        hub: {
          mergeApprovals: {
            request: async (opts: any) => {
              hubCalls.push(opts);
              return {
                id: ID,
                status: "pending",
                repo: "o/r",
                pr_number: 7,
                head_sha: HEAD,
                expires_at: "later",
              };
            },
            status: async (opts: any) => {
              hubCalls.push(opts);
              return [];
            },
          },
        },
      }),
    projectChatArtifactData: async (args: any) => {
      calls.push(args);
      if (args.action === "list") return existing;
      return { artifact_id: "card" };
    },
  } as any);
  return { root, calls, hubCalls };
}

const args = [
  "project",
  "chat",
  "merge-approval",
  "request",
  "--repo",
  "o/r",
  "--pr",
  "7",
  "--head",
  HEAD,
  "--agent-label",
  "@ops3",
  "--path",
  "/a.chat",
  "--thread-id",
  "t",
  "--message-date",
  "d",
];

test("requests approval through the hub, then publishes a card with only the request id", async () => {
  const { root, calls, hubCalls } = setup();
  await root.parseAsync(args, { from: "user" });
  assert.deepEqual(hubCalls, [
    {
      repo: "o/r",
      pr_number: 7,
      head_sha: HEAD,
      agent_label: "@ops3",
      chat: { path: "/a.chat", thread_id: "t", message_date: "d" },
    },
  ]);
  const publish = calls.find((c) => c.action === "publish");
  assert.equal(publish.path, "/a.chat");
  assert.equal(publish.threadId, "t");
  assert.equal(publish.messageDate, "d");
  assert.deepEqual(publish.payload, {
    title: "Merge approval request",
    markdown: "",
    merge_approval: { request_ids: [ID] },
  });
  // Nothing about the PR goes into the chat.
  assert.ok(!JSON.stringify(publish.payload).includes(HEAD));
  assert.ok(!JSON.stringify(publish.payload).includes("o/r"));
});

test("reuses the card already published for the same request", async () => {
  const { root, calls } = setup([
    { artifact_id: "old", merge_approval: { request_ids: [ID] } },
  ]);
  await root.parseAsync(args, { from: "user" });
  assert.equal(calls.filter((c) => c.action === "publish").length, 0);
});

test("needs the current chat turn", async () => {
  const keys = [
    "COCALC_CODEX_CHAT_PATH",
    "COCALC_CODEX_THREAD_ID",
    "COCALC_CODEX_MESSAGE_DATE",
  ];
  const previous = keys.map((key) => process.env[key]);
  keys.forEach((key) => delete process.env[key]);
  try {
    const { root, hubCalls } = setup();
    await assert.rejects(
      root.parseAsync(args.slice(0, 12), { from: "user" }),
      /current chat turn/,
    );
    assert.equal(hubCalls.length, 0);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] !== undefined) process.env[key] = previous[i];
    });
  }
});

test("reads a note only up to the limit, from stdin or a file", async () => {
  let produced = 0;
  async function* endless() {
    for (;;) {
      produced += 1024;
      yield Buffer.alloc(1024, 120);
    }
  }
  await assert.rejects(readNote("-", endless()), /longer than 8192 bytes/);
  assert.ok(produced <= 9 * 1024);
  const dir = mkdtempSync(join(tmpdir(), "note-"));
  const big = join(dir, "big.md");
  writeFileSync(big, "x".repeat(1024 * 1024));
  await assert.rejects(readNote(big), /longer than 8192 bytes/);
  const ok = join(dir, "ok.md");
  writeFileSync(ok, "fine");
  assert.equal(await readNote(ok), "fine");
  assert.equal(await readNote(undefined), undefined);
});
