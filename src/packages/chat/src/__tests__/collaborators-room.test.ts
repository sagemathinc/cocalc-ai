import {
  createHumanThread,
  initializeHumanRoom,
  sendHumanMessage,
} from "../collaborators-room";
import { COLLABORATION_ROOM_PATH } from "@cocalc/util/collaborators";

const room = {
  project_id: "11111111-1111-4111-8111-111111111111",
  room_id: "22222222-2222-4222-8222-222222222222",
  chat_path: COLLABORATION_ROOM_PATH,
};
const account_id = "33333333-3333-4333-8333-333333333333";
const thread_id = "44444444-4444-4444-8444-444444444444";
const message_id = "55555555-5555-4555-8555-555555555555";
function fixture() {
  const rows: any[] = [];
  return {
    rows,
    db: {
      get: () => rows,
      set: jest.fn((row) => {
        const index = rows.findIndex(
          (existing) =>
            existing.event === row.event &&
            existing.sender_id === row.sender_id &&
            existing.date === row.date &&
            existing.thread_id === row.thread_id &&
            existing.message_id === row.message_id,
        );
        if (index < 0) rows.push(row);
        else rows[index] = row;
      }),
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      save_to_disk: jest.fn(async () => {}),
    },
  };
}

test("room initialization retries a lost disk acknowledgement without duplicate records", async () => {
  const { rows, db } = fixture();
  db.save_to_disk.mockRejectedValueOnce(Error("lost ack"));
  await expect(initializeHumanRoom(db, room)).rejects.toThrow("lost ack");
  await initializeHumanRoom(db, room);
  expect(rows).toHaveLength(1);
  expect(db.save_to_disk).toHaveBeenCalledTimes(2);
});

test("concurrent retry of human thread creation never overwrites its shared title", async () => {
  const { rows, db } = fixture();
  await initializeHumanRoom(db, room);
  const opts = { room, thread_id, account_id, title: "Original" };
  await Promise.all([createHumanThread(db, opts), createHumanThread(db, opts)]);
  const config = rows.find((row) => row.event === "chat-thread-config");
  config.name = "Shared rename";
  await createHumanThread(db, opts);
  expect(config.agent_kind).toBe("none");
  expect(config.name).toBe("Shared rename");
  expect(rows).toHaveLength(3);
});

test("agent mentions remain human text and repeated message operations do not double post", async () => {
  const { rows, db } = fixture();
  await initializeHumanRoom(db, room);
  await createHumanThread(db, { room, thread_id, account_id });
  const opts = {
    room,
    thread_id,
    account_id,
    message_id,
    text: "@codex and @[agent](cocalc://agent/reference) are references",
  };
  db.save.mockRejectedValueOnce(Error("reconnect"));
  await expect(sendHumanMessage(db, opts)).rejects.toThrow("reconnect");
  await sendHumanMessage(db, opts);
  const messages = rows.filter((row) => row.event === "chat");
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    message_id,
    sender_id: account_id,
    generating: false,
  });
  expect(messages[0].history[0].content).toBe(opts.text);
  expect(messages[0].acp_thread_id).toBeUndefined();
  expect(rows.find((row) => row.event === "chat-thread").root_message_id).toBe(
    message_id,
  );
});

test("does not adopt another chat or send into agent/archived threads", async () => {
  const { rows, db } = fixture();
  rows.push({ event: "chat" });
  await expect(initializeHumanRoom(db, room)).rejects.toThrow(/adoption/);
  rows.length = 0;
  await initializeHumanRoom(db, room);
  await createHumanThread(db, { room, thread_id, account_id });
  const config = rows.find((row) => row.event === "chat-thread-config");
  for (const patch of [
    { agent_kind: "acp" },
    { agent_kind: "none", archived: true },
    { archived: false, acp_config: {} },
  ]) {
    Object.assign(config, patch);
    await expect(
      sendHumanMessage(db, {
        room,
        thread_id,
        account_id,
        message_id,
        text: "test",
      }),
    ).rejects.toThrow(/human-only/);
  }
});
