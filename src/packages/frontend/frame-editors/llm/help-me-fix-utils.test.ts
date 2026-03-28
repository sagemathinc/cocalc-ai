import { createNavigatorIntentMessage } from "./help-me-fix-utils";

describe("createNavigatorIntentMessage", () => {
  it("tells the agent to use live sync state instead of relying on disk", () => {
    const prompt = createNavigatorIntentMessage({
      message: "Help me fix this.",
      project_id: "project-1",
      path: "/tmp/test.ipynb",
      isHint: false,
      sourceTag: "help-me-fix:solution",
    });

    expect(prompt).toContain(
      "Treat the live in-memory sync version of the document as the source of truth.",
    );
    expect(prompt).toContain(
      "Do not rely on the filesystem copy being current; use live document APIs when available.",
    );
    expect(prompt).toContain('"codex_model": "gpt-5.4-mini"');
  });
});
