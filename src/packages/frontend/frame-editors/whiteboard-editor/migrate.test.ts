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
  it("imports legacy slides markdown without escaped delimiters", () => {
    const doc = syncdoc(
      [
        JSON.stringify({
          data: {
            color: "#252937",
            fontSize: 24,
            initStr: "\n# \n",
            placeholder: "# Click to edit title\n\n",
          },
          h: 121,
          id: "title",
          page: "page-1",
          str: String.raw`# \[hsy\] William \(and Bella\)` + "\n\n",
          type: "text",
          w: 847,
          x: -200,
          y: -492,
          z: 0,
        }),
        JSON.stringify({
          data: { color: "#fff9c4" },
          h: 101,
          id: "note",
          page: "page-1",
          str:
            String.raw`\[ws\] Harald \(and Blaec\)` + "\n\n\n$$\nx^3\n$$\n\n",
          type: "note",
          w: 350,
          x: -147,
          y: -272,
          z: 1,
        }),
        JSON.stringify({
          data: { pos: 0 },
          id: "page-1",
          type: "page",
          z: 0,
        }),
        JSON.stringify({
          id: "code",
          type: "code",
          page: "page-1",
          z: 2,
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          str: String.raw`print("\[keep code escaped\]")`,
        }),
      ].join("\n"),
    );

    expect(migrateToCurrentDocumentSchema(doc)).toBe(true);

    const rows = doc.content.split("\n").map((line) => JSON.parse(line));
    expect(rows.find((row) => row.id === "title").str).toBe(
      "# [hsy] William (and Bella)\n\n",
    );
    expect(rows.find((row) => row.id === "note").str).toBe(
      "[ws] Harald (and Blaec)\n\n\n$$\nx^3\n$$\n\n",
    );
    expect(rows.find((row) => row.id === "code").str).toBe(
      String.raw`print("\[keep code escaped\]")`,
    );
    expect(rows.find((row) => row.id === "page-1").data.schemaVersion).toBe(1);
  });

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
