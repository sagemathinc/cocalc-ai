import {
  nameArtifact,
  normalizeArtifactName,
  readArtifactNames,
} from "./artifact-names";

const project_id = "756629fd-ce98-4596-8595-1071d6c019a6";
const entry_id = "6".repeat(64);
const other = "7".repeat(64);

test("names are account-wide and old names continue resolving after a rename", () => {
  const first = nameArtifact([], { project_id, entry_id }, " NB1 ");
  expect(first).toEqual([{ name: "nb1", project_id, entry_id, active: true }]);
  const renamed = nameArtifact(first, { project_id, entry_id }, "notebook");
  expect(renamed).toEqual([
    { name: "nb1", project_id, entry_id, active: false },
    { name: "notebook", project_id, entry_id, active: true },
  ]);
  expect(() =>
    nameArtifact(renamed, { project_id, entry_id: other }, "nb1"),
  ).toThrow("already used");
});

test("invalid names and persisted data cannot create ambiguous aliases", () => {
  expect(normalizeArtifactName("N")).toBe("n");
  expect(() => normalizeArtifactName("bad/name")).toThrow();
  expect(() => normalizeArtifactName("-bad")).toThrow();
  expect(
    readArtifactNames(
      JSON.stringify([
        { name: "nb1", project_id, entry_id, active: true },
        { name: "nb1", project_id, entry_id: other, active: true },
        { name: "bad/name", project_id, entry_id: other, active: true },
      ]),
    ),
  ).toEqual([{ name: "nb1", project_id, entry_id, active: true }]);
});
