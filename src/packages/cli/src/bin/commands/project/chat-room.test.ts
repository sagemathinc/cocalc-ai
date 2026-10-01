import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { collaborationRoomReplacementOperationId } from "@cocalc/util/collaboration-room-replacement";
import { registerChatRoomCommands } from "./chat-room";

let previousIdentity: string | undefined;
beforeEach(() => {
  previousIdentity = process.env.COCALC_AGENT_IDENTITY_FILE;
  delete process.env.COCALC_AGENT_IDENTITY_FILE;
});
afterEach(() => {
  if (previousIdentity == null) delete process.env.COCALC_AGENT_IDENTITY_FILE;
  else process.env.COCALC_AGENT_IDENTITY_FILE = previousIdentity;
});

function setup() {
  const account_id = randomUUID(),
    project_id = randomUUID(),
    room_id = randomUUID();
  const room = {
    project_id,
    room_id,
    chat_path: "/home/user/old.chat",
    initialized: true,
  };
  const calls: string[] = [];
  let output: any, sent: any;
  const ctx = {
    accountId: account_id,
    timeoutMs: 1234,
    hub: {
      collaborators: {
        getRoom: async (input: unknown) => {
          calls.push("getRoom");
          assert.deepEqual(input, { account_id, project_id });
          return room;
        },
      },
    },
  };
  const client = {
    request: async (_subject: string, payload: any) => {
      calls.push("replaceRoom");
      sent = payload[1][0];
      return {
        data: {
          outcome: "ready",
          operation_id: collaborationRoomReplacementOperationId(
            project_id,
            account_id,
            sent.request_id,
          ),
          room: {
            ...room,
            room_id: randomUUID(),
            chat_path: "/home/user/new.chat",
          },
        },
      };
    },
  };
  const program = new Command().exitOverride();
  registerChatRoomCommands(program.command("chat"), {
    withContext: async (_command: unknown, _name: unknown, action: any) => {
      calls.push("context");
      output = await action(ctx);
    },
    resolveProjectFromArgOrContext: async () => {
      calls.push("resolve");
      return { project_id };
    },
    resolveProjectConatClient: async () => {
      calls.push("host");
      return { project: { project_id }, client };
    },
  } as any);
  const args = [
    "chat",
    "room",
    "replace",
    "--expected-room-id",
    room_id,
    "--expected-path",
    room.chat_path,
  ];
  return { program, calls, args, output: () => output, sent: () => sent };
}

test("room status is metadata-only and does not connect to project compute", async () => {
  const f = setup();
  await f.program.parseAsync(["chat", "room", "status"], { from: "user" });
  assert.deepEqual(f.calls, ["context", "resolve", "getRoom"]);
  assert.equal(f.output().initialized, true);
});

test("replacement requires explicit confirmation before authentication or I/O", async () => {
  const f = setup();
  await assert.rejects(
    f.program.parseAsync(f.args, { from: "user" }),
    /--confirm/,
  );
  assert.deepEqual(f.calls, []);
});

test("runtime identity cannot fall back to human credentials", async () => {
  const f = setup();
  const previous = process.env.COCALC_AGENT_IDENTITY_FILE;
  process.env.COCALC_AGENT_IDENTITY_FILE = "/runtime/identity";
  try {
    await assert.rejects(
      f.program.parseAsync([...f.args, "--confirm"], { from: "user" }),
      /human account/,
    );
    assert.deepEqual(f.calls, []);
  } finally {
    if (previous == null) delete process.env.COCALC_AGENT_IDENTITY_FILE;
    else process.env.COCALC_AGENT_IDENTITY_FILE = previous;
  }
});

test("confirmed replacement reports stable retry ID before host routing and preserves it", async () => {
  const f = setup();
  const request_id = randomUUID();
  let message = "";
  const stderr = mock.method(process.stderr, "write", (chunk: any) => {
    assert.equal(f.calls.includes("host"), false);
    message += chunk;
    return true;
  });
  try {
    await f.program.parseAsync(
      [...f.args, "--confirm", "--request-id", request_id],
      { from: "user" },
    );
    assert.ok(message.includes(request_id));
    assert.equal(f.sent().request_id, request_id);
    assert.equal(f.output().request_id, request_id);
    assert.deepEqual(f.calls, ["context", "resolve", "host", "replaceRoom"]);
  } finally {
    stderr.mock.restore();
  }
});

test("invalid expected path or request ID never reaches project compute", async () => {
  for (const extra of [
    ["--expected-path", "relative.chat"],
    ["--request-id", "broken"],
  ]) {
    const f = setup();
    await assert.rejects(
      f.program.parseAsync([...f.args, "--confirm", ...extra], {
        from: "user",
      }),
    );
    assert.equal(f.calls.includes("host"), false);
  }
});
