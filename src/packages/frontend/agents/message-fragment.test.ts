import { agentMessageFragment } from "./message-fragment";

test("accepts message anchors for the current conversation, with or without a thread", () => {
  expect(agentMessageFragment({ chat: "1700000000000" }, "current")).toBe(
    "1700000000000",
  );
  expect(
    agentMessageFragment(
      { chat: "1700000000000", thread: "current" },
      "current",
    ),
  ).toBe("1700000000000");
});

test("ignores historical-thread and invalid anchors", () => {
  expect(
    agentMessageFragment({ chat: "1700000000000", thread: "past" }, "current"),
  ).toBeUndefined();
  for (const chat of ["", "NaN", "-1", "123abc", "9".repeat(100)]) {
    expect(agentMessageFragment({ chat }, "current")).toBeUndefined();
  }
});
