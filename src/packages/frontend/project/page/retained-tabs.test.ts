import { retainTab } from "./retained-tabs";

describe("retainTab", () => {
  it("keeps the same array when there is no tab to retain", () => {
    const tabs = ["files"] as const;
    expect(retainTab(tabs, null)).toBe(tabs);
    expect(retainTab(tabs, undefined)).toBe(tabs);
  });

  it("keeps the same array when the tab is already retained", () => {
    const tabs = ["files", "agents"] as const;
    expect(retainTab(tabs, "files")).toBe(tabs);
  });

  it("appends a newly retained tab", () => {
    expect(retainTab(["files"], "agents")).toEqual(["files", "agents"]);
  });
});
