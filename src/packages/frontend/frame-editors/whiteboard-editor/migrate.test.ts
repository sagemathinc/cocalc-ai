import { migrateToCurrentDocumentSchema } from "./migrate";

function syncdoc(content: string) {
  return {
    content,
    committed: false,
    to_str() {
      return this.content;
    },
    from_str(content: string) {
      this.content = content;
    },
    commit() {
      this.committed = true;
    },
  };
}

describe("whiteboard document migrations", () => {
  it("converts unversioned page-id documents to schema v1", () => {
    const doc = syncdoc(
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
          str: String.raw`Title \(the slide\) and \[not math\]`,
        }),
      ].join("\n"),
    );

    expect(migrateToCurrentDocumentSchema(doc)).toBe(true);
    expect(doc.committed).toBe(true);

    const rows = doc.content.split("\n").map((line) => JSON.parse(line));
    expect(rows[0].data.schemaVersion).toBe(1);
    expect(rows[1].str).toBe("Title (the slide) and [not math]");
  });

  it("does not rewrite current schema documents", () => {
    const content = [
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
        str: String.raw`Title \(the slide\)`,
      }),
    ].join("\n");
    const doc = syncdoc(content);

    expect(migrateToCurrentDocumentSchema(doc)).toBe(false);
    expect(doc.committed).toBe(false);
    expect(doc.content).toBe(content);
  });
});
