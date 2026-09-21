import { chatIsForeground } from "./embedding-options";
import { path_to_tab } from "@cocalc/util/misc";

test("Agents viewing does not require a matching project tab for read acknowledgement", () => {
  expect(chatIsForeground("agent.chat", "files", true)).toBe(true);
  expect(chatIsForeground("agent.chat", undefined, true)).toBe(true);
  expect(
    chatIsForeground("agent.chat", path_to_tab("agent.chat"), true, false),
  ).toBe(false);
  expect(chatIsForeground("agent.chat", "files", false)).toBe(false);
  expect(chatIsForeground("agent.chat", path_to_tab("agent.chat"), false)).toBe(
    true,
  );
});
