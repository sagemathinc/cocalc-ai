import { backupPathAcknowledgementKey } from "./backup-path-acknowledgement";

it("identifies only the exact path, including arbitrary filename bytes", () => {
  const key = backupPathAcknowledgementKey("64622fff");
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(backupPathAcknowledgementKey("64622fff")).toBe(key);
  expect(backupPathAcknowledgementKey("64622ffe")).not.toBe(key);
  expect(backupPathAcknowledgementKey("6462")).not.toBe(key);
});

it.each([
  "",
  "2f61",
  "612f",
  "2e",
  "612f2e2e2f62",
  "00",
  "Ff",
  "f",
  "aa".repeat(4097),
])("rejects noncanonical or unbounded paths %#", (path) =>
  expect(() => backupPathAcknowledgementKey(path)).toThrow(),
);
