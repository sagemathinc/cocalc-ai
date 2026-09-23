import {
  movePersonalLibraryPin,
  normalizePersonalLibraryName,
  parsePersonalLibraryPinKey,
  validatePersonalLibraryPinKey,
} from "./personal-library";

const project_id = "11111111-1111-4111-8111-111111111111";
const pin = JSON.stringify([project_id, "/chat.chat", "thread", "artifact"]);

test("normalizes names and rejects malformed identities", () => {
  expect(normalizePersonalLibraryName(" NB-1 ")).toBe("nb-1");
  expect(() => normalizePersonalLibraryName("bad/name")).toThrow();
});

test("pin keys are canonical and visible reordering leaves hidden slots alone", () => {
  expect(validatePersonalLibraryPinKey(pin)).toBe(pin);
  expect(parsePersonalLibraryPinKey(pin)).toEqual({
    project_id,
    chat_path: "/chat.chat",
    thread_id: "thread",
    artifact_id: "artifact",
  });
  expect(() =>
    validatePersonalLibraryPinKey(
      JSON.stringify([project_id, "/bad/../chat.chat", "thread", "artifact"]),
    ),
  ).toThrow("Invalid artifact pin");
  expect(
    movePersonalLibraryPin(["a", "hidden", "b"], ["a", "b"], "b", 0),
  ).toEqual(["b", "hidden", "a"]);
});
