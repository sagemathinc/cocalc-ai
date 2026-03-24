import { rewriteBlobReferencesInPrompt } from "../blob-materialization";

describe("rewriteBlobReferencesInPrompt", () => {
  it("replaces markdown and html blob refs with attachment placeholders", () => {
    const prompt = [
      "Turn this into code:",
      "",
      "![scan](/blobs/paste-a?uuid=11111111-1111-4111-8111-111111111111)",
      "",
      '<img src="/blobs/paste-b.png?uuid=22222222-2222-4222-8222-222222222222" width="100" />',
    ].join("\n");
    const rewritten = rewriteBlobReferencesInPrompt(prompt, [
      {
        ref: {
          url: "/blobs/paste-a?uuid=11111111-1111-4111-8111-111111111111",
          uuid: "11111111-1111-4111-8111-111111111111",
        },
        path: "/tmp/a.png",
      },
      {
        ref: {
          url: "/blobs/paste-b.png?uuid=22222222-2222-4222-8222-222222222222",
          uuid: "22222222-2222-4222-8222-222222222222",
        },
        path: "/tmp/b.png",
      },
    ]);

    expect(rewritten).toContain("[Attached image 1]");
    expect(rewritten).toContain("[Attached image 2]");
    expect(rewritten).not.toContain("/blobs/");
    expect(rewritten).not.toContain("<img");
    expect(rewritten).not.toContain("![scan]");
  });
});
