import {
  deriveBayControlPlaneOrigin,
  normalizeControlPlaneOrigin,
} from "./control-plane-origin";

describe("deriveBayControlPlaneOrigin", () => {
  it("derives a bay origin from the stable site origin", () => {
    expect(
      deriveBayControlPlaneOrigin("https://lite4b.cocalc.ai", "bay-2"),
    ).toBe("https://bay-2-lite4b.cocalc.ai");
  });

  it("replaces an attached-bay hostname with the requested bay", () => {
    expect(
      deriveBayControlPlaneOrigin("https://bay-1-lite4b.cocalc.ai", "bay-2"),
    ).toBe("https://bay-2-lite4b.cocalc.ai");
  });

  it("normalizes trailing slashes before deriving", () => {
    expect(
      deriveBayControlPlaneOrigin("https://lite4b.cocalc.ai/", "bay-0"),
    ).toBe(normalizeControlPlaneOrigin("https://bay-0-lite4b.cocalc.ai"));
  });
});
