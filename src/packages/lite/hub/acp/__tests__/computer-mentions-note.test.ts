import { serializeComputerMention } from "@cocalc/util/computer-mentions";
import { humanTurnComputerNote } from "../turn-mentions";

const project_id = "756629fd-ce98-4596-8595-1071d6c019a6";
const account_id = "ca35aaf2-a22d-482b-a846-199bf58f3477";
const m1 = serializeComputerMention({
  version: 1,
  computer_id: "1a057860-889d-461a-9073-4b8c69d65123",
  name: "m1",
});
const human = {
  account_id,
  project_id,
  chat: { project_id, user_message_content: `disk usage on ${m1}?` },
} as any;

test("a human turn's @computer mentions become a note for the agent", () => {
  const note = humanTurnComputerNote(human);
  expect(note).toContain(
    "- @m1: computer 1a057860-889d-461a-9073-4b8c69d65123",
  );
  expect(note).toContain("cocalc computer exec ID --");
});

test("an agent's message, or a plain @name, adds nothing", () => {
  expect(
    humanTurnComputerNote({
      ...human,
      chat: { ...human.chat, agent_message: true },
    }),
  ).toBe("");
  expect(
    humanTurnComputerNote({
      ...human,
      chat: { project_id, user_message_content: "plain @m1" },
    }),
  ).toBe("");
});
