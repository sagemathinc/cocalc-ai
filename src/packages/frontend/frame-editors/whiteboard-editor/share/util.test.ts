import { parseSyncdbFile } from "./util";

describe("whiteboard share file parser", () => {
  it("normalizes legacy escaped delimiters in unversioned page-id files", () => {
    const pages = parseSyncdbFile(
      [
        JSON.stringify({
          id: "page",
          type: "page",
          z: 0,
          data: { pos: 0 },
        }),
        JSON.stringify({
          id: "text",
          type: "text",
          page: "page",
          z: 0,
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          str: String.raw`Title \(the slide\)`,
        }),
      ].join("\n"),
    );

    expect(pages[0].find((element) => element.id === "text")?.str).toBe(
      "Title (the slide)",
    );
  });

  it("preserves escaped delimiters in current schema page-id files", () => {
    const str = String.raw`Title \(the slide\)`;
    const pages = parseSyncdbFile(
      [
        JSON.stringify({
          id: "page",
          type: "page",
          z: 0,
          data: { pos: 0, schemaVersion: 1 },
        }),
        JSON.stringify({
          id: "text",
          type: "text",
          page: "page",
          z: 0,
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          str,
        }),
      ].join("\n"),
    );

    expect(pages[0].find((element) => element.id === "text")?.str).toBe(str);
  });
});
