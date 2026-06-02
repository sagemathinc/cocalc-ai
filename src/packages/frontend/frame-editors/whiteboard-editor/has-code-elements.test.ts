import { hasCodeElements } from "./has-code-elements";

describe("hasCodeElements", () => {
  it("is false for slides pages with only text and fixed slide elements", () => {
    expect(
      hasCodeElements([
        { id: "slide", type: "slide", x: 0, y: 0, w: 100, h: 100, z: 0 },
        { id: "title", type: "text", x: 0, y: 0, w: 100, h: 30, z: 1 },
      ]),
    ).toBe(false);
  });

  it("is true when the page has a code element", () => {
    expect(
      hasCodeElements([
        { id: "title", type: "text", x: 0, y: 0, w: 100, h: 30, z: 1 },
        { id: "code", type: "code", x: 0, y: 40, w: 100, h: 80, z: 2 },
      ]),
    ).toBe(true);
  });
});
