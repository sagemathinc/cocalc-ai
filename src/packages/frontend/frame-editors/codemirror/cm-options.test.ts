import { cm_options } from "./cm-options";

describe("cm_options", () => {
  it("uses a 1s history grouping window for undo steps", () => {
    const editorSettings = {
      get(key: string, fallback?: unknown) {
        const values: Record<string, unknown> = {
          theme: "default",
          tab_size: 4,
          bindings: "standard",
        };
        return key in values ? values[key] : fallback;
      },
    } as any;

    const options = cm_options("example.txt", editorSettings);

    expect(options.historyEventDelay).toBe(1000);
  });
});
