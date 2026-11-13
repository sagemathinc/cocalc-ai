import { withGodebug } from "./godebug";

describe("withGodebug", () => {
  it("adds the setting", () => {
    expect(withGodebug(undefined, "multipathtcp=0")).toBe("multipathtcp=0");
    expect(withGodebug("", "multipathtcp=0")).toBe("multipathtcp=0");
  });

  it("keeps other settings and replaces the same key", () => {
    expect(withGodebug("http2debug=1", "multipathtcp=0")).toBe(
      "http2debug=1,multipathtcp=0",
    );
    expect(withGodebug("multipathtcp=1, http2debug=1", "multipathtcp=0")).toBe(
      "http2debug=1,multipathtcp=0",
    );
  });
});
