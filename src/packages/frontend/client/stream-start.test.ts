/** @jest-environment jsdom */

import { resolveExplicitStreamStart } from "./stream-start";

describe("resolveExplicitStreamStart", () => {
  it("prefers the documented option flag when present", () => {
    expect(resolveExplicitStreamStart(true, false)).toBe(true);
    expect(resolveExplicitStreamStart(false, true)).toBe(false);
  });

  it("falls back to the legacy positional flag when the option is omitted", () => {
    expect(resolveExplicitStreamStart(undefined, true)).toBe(true);
    expect(resolveExplicitStreamStart(undefined, false)).toBe(false);
  });
});
