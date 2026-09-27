import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { collaborationRoomReplacementOperationId } from "@cocalc/util/collaboration-room-replacement";
import { submitRoomReplacement } from "./project-chat-room";

function fixture() {
  const accountId = randomUUID();
  const request = {
    version: 1 as const,
    project_id: randomUUID(),
    request_id: randomUUID(),
    expected_room_id: randomUUID(),
    expected_chat_path: "/home/user/old.chat",
  };
  const result = {
    outcome: "ready" as const,
    operation_id: collaborationRoomReplacementOperationId(
      request.project_id,
      accountId,
      request.request_id,
    ),
    room: {
      project_id: request.project_id,
      room_id: randomUUID(),
      chat_path: "/home/user/new.chat",
      initialized: true,
    },
  };
  const calls: unknown[][] = [];
  const client = {
    request: async (...args: unknown[]) => {
      calls.push(args);
      return { data: result };
    },
  };
  return { accountId, request, result, calls, client: client as any };
}

test("replacement uses only the human-bound service and repeats the exact intent", async () => {
  const f = fixture();
  assert.deepEqual(await submitRoomReplacement(f), {
    ...f.result,
    request_id: f.request.request_id,
  });
  await submitRoomReplacement(f);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.deepEqual(f.calls[0], [
    `services.account-${f.accountId}._.${f.request.project_id}._.collaborators`,
    ["replaceRoom", [f.request]],
    { timeout: 60000, waitForInterest: true },
  ]);
});

test("invalid identities or request fields fail before transport", async () => {
  for (const patch of [
    { accountId: "not-human" },
    { request: { ...fixture().request, expected_chat_path: "raw.chat" } },
    { request: { ...fixture().request, confirmed: true } },
  ]) {
    const f = fixture();
    await assert.rejects(submitRoomReplacement({ ...f, ...patch } as any));
    assert.equal(f.calls.length, 0);
  }
});

test("unknown outcome retains retry identity and never automatically retransmits", async () => {
  const f = fixture();
  let sends = 0;
  f.client.request = async () => {
    sends++;
    throw Error("timeout after commit");
  };
  await assert.rejects(submitRoomReplacement(f), (error: Error) => {
    assert.match(error.message, /same expected room\/path/);
    assert.ok(error.message.includes(f.request.request_id));
    return true;
  });
  assert.equal(sends, 1);
});

test("operation or room acknowledgement mismatch is not reported as success", async () => {
  for (const result of [
    { operation_id: randomUUID(), outcome: "ready" },
    { outcome: "unknown" },
    { room: { project_id: randomUUID(), room_id: randomUUID() } },
  ]) {
    const f = fixture();
    f.client.request = async () => ({ data: { ...f.result, ...result } });
    await assert.rejects(submitRoomReplacement(f), /not confirmed/);
  }
});

test("superseded returns no actionable room path", async () => {
  const f = fixture();
  const data = {
    outcome: "superseded",
    operation_id: f.result.operation_id,
    replacement_room_id: f.result.room.room_id,
  };
  f.client.request = async () => ({ data });
  assert.deepEqual(await submitRoomReplacement(f), {
    ...data,
    request_id: f.request.request_id,
  });
});
