import { changedFileLabel, prepareChangedFiles } from "./changed-files-model";

it("preserves literal unusual paths, rename identity and deletion entries", () => {
  const files = [
    {
      id: "rename",
      path: "src/new name.ts",
      oldPath: "src/old.ts",
      status: "renamed" as const,
      commentCount: 2,
    },
    {
      id: "deleted",
      path: "-literal/[glob]\t\n\\.ts",
      status: "deleted" as const,
    },
    { id: "unicode", path: "src/λ.ts" },
  ];
  const result = prepareChangedFiles(files);
  expect(result.error).toBe("");
  expect([...result.byPath.values()]).toEqual(files);
  expect(changedFileLabel(files[0])).toBe(
    "src/old.ts -> src/new name.ts; renamed; 2 comments",
  );
});

it.each([["x", "x/y"], ["x/y", "x"], ["x", "x"], ["/x"], ["x//y"], ["x/../y"]])(
  "rejects ambiguous tree paths %j",
  (...paths) => {
    expect(
      prepareChangedFiles(paths.map((path, i) => ({ id: String(i), path })))
        .error,
    ).not.toBe("");
  },
);

it("accepts empty reviews and rejects duplicate identities", () => {
  expect(prepareChangedFiles([]).error).toBe("");
  expect(
    prepareChangedFiles([
      { id: "same", path: "x" },
      { id: "same", path: "y" },
    ]).error,
  ).not.toBe("");
});
