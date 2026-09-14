import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@cocalc/conat/core/client";
import type { AcpAutomationRequest } from "@cocalc/conat/ai/acp/types";
import { humanChatAutomation } from "./chat-automation";

const request: AcpAutomationRequest = {
  account_id: "P",
  project_id: "project",
  path: "a.chat",
  thread_id: "thread",
  action: "upsert",
};
test("human cookie and signed routed-account CLI sessions use the typed scheduling request exactly once", async () => {
  for (const user of [
    { account_id: "P", auth_session_hash: "cookie-session" },
    { account_id: "P", auth_actor: "account" },
  ]) {
    const client = { info: { user } } as Client;
    let count = 0;
    const result = await humanChatAutomation(
      request,
      client,
      async (sent, transport) => {
        count++;
        assert.equal(sent, request);
        assert.equal(transport, client);
        return { ok: true };
      },
    );
    assert.equal(result.ok, true);
    assert.equal(count, 1);
  }
});
test("agent, project, unmarked legacy, and mismatched accounts cannot become settings writers", async () => {
  for (const user of [
    { account_id: "P", auth_actor: "agent", auth_session_hash: "forged" },
    { project_id: "project" },
    { account_id: "P" },
    { account_id: "Q", auth_actor: "account" },
  ]) {
    let sent = false;
    await assert.rejects(
      humanChatAutomation(request, { info: { user } } as Client, async () => {
        sent = true;
        return { ok: true };
      }),
      /authenticated human account session/,
    );
    assert.equal(sent, false);
  }
});
test("a lost scheduling acknowledgment is not automatically replayed", async () => {
  let count = 0;
  await assert.rejects(
    humanChatAutomation(
      request,
      {
        info: {
          user: {
            account_id: "P",
            auth_actor: "account",
          },
        },
      } as Client,
      async () => {
        count++;
        throw new Error("ack lost");
      },
    ),
    /ack lost/,
  );
  assert.equal(count, 1);
});

test("the entire automation RPC is human-only, including acknowledgment, with no credential fallback", async () => {
  const actions: AcpAutomationRequest["action"][] = [
    "upsert",
    "pause",
    "resume",
    "run_now",
    "skip_next",
    "acknowledge",
    "delete",
  ];
  const client = {
    info: { user: { account_id: "P", auth_actor: "agent" } },
  } as Client;
  let submitted = 0;
  for (const action of actions) {
    await assert.rejects(
      humanChatAutomation({ ...request, action }, client, async () => {
        submitted++;
        return { ok: true };
      }),
      /authenticated human account session/,
    );
  }
  assert.equal(submitted, 0);
  assert.equal(client.info?.user?.auth_actor, "agent");
});
