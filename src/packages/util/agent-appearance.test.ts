import { normalizeAgentAppearance } from "./agent-appearance";

test("keeps known non-empty fields, trimmed", () => {
  expect(
    normalizeAgentAppearance({
      name: " Reviewer ",
      thread_color: "#123456",
      thread_icon: "",
      other: "x",
      thread_image: 5,
    }),
  ).toEqual({ name: "Reviewer", thread_color: "#123456" });
});

test("empty or invalid input is null; overlong fields are rejected", () => {
  expect(normalizeAgentAppearance(null)).toBeNull();
  expect(normalizeAgentAppearance("x")).toBeNull();
  expect(normalizeAgentAppearance({ name: "  " })).toBeNull();
  expect(() => normalizeAgentAppearance({ name: "x".repeat(201) })).toThrow(
    "too long",
  );
});
