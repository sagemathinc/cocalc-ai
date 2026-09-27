import {
  assertHumanRoomConfigPatch,
  isHumanOnlyChat,
  isHumanOnlyThreadConfig,
} from "./collaboration-human-room";

test("human-only restriction comes from a room marker, not an alias or path", () => {
  expect(isHumanOnlyChat(undefined)).toBe(false);
  expect(
    isHumanOnlyChat([{ event: "chat", content: "collaborators-room" }]),
  ).toBe(false);
  expect(isHumanOnlyChat([{ event: "collaborators-room" }])).toBe(true);
});

test("ordinary shared title and appearance changes remain possible", () => {
  expect(() =>
    assertHumanRoomConfigPatch({
      name: "Geometry",
      color: "blue",
      agent_kind: "none",
    }),
  ).not.toThrow();
});

test.each([
  { agent_kind: "acp" },
  { agent_kind: "llm" },
  { acp_config: {} },
  { agent_model: "model" },
  { automation_config: { enabled: true } },
])("human room rejects AI conversion: %j", (patch) => {
  expect(() => assertHumanRoomConfigPatch(patch)).toThrow("human-only");
  expect(isHumanOnlyThreadConfig({ agent_kind: "none", ...patch })).toBe(
    "automation_config" in patch,
  );
});
