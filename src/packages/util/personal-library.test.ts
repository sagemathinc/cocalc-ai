import {
  movePersonalLibraryPin,
  normalizeLegacyPersonalLibraryAliases,
  normalizeLegacyPersonalLibraryPins,
  normalizePersonalLibraryName,
  validatePersonalLibraryPinKey,
} from "./personal-library";

const project_id = "11111111-1111-4111-8111-111111111111";
const entry_id = "a".repeat(64);
const pin = JSON.stringify([project_id, "/chat.chat", "thread", "artifact"]);

test("normalizes names and rejects malformed identities", () => {
  expect(normalizePersonalLibraryName(" NB-1 ")).toBe("nb-1");
  expect(() => normalizePersonalLibraryName("bad/name")).toThrow();
  expect(
    normalizeLegacyPersonalLibraryAliases([
      { name: "nb1", project_id, entry_id, active: true },
      { name: "nb1", project_id, entry_id, active: false },
      { name: "bad/name", project_id, entry_id, active: true },
    ]),
  ).toEqual([{ name: "nb1", project_id, entry_id, active: true }]);
});

test("pin keys are canonical and visible reordering leaves hidden slots alone", () => {
  expect(validatePersonalLibraryPinKey(pin)).toBe(pin);
  expect(normalizeLegacyPersonalLibraryPins([pin, pin, "invalid"])).toEqual([
    pin,
  ]);
  expect(
    movePersonalLibraryPin(["a", "hidden", "b"], ["a", "b"], "b", 0),
  ).toEqual(["b", "hidden", "a"]);
});
