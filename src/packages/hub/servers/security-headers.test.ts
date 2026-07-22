import { applyBaselineSecurityHeaders } from "./security-headers";

describe("applyBaselineSecurityHeaders", () => {
  it("isolates cross-origin openers while preserving OAuth popups", () => {
    const headers = new Map<string, string>();
    const res = {
      hasHeader: (name: string) => headers.has(name),
      setHeader: (name: string, value: string) => headers.set(name, value),
    };
    const next = jest.fn();

    applyBaselineSecurityHeaders(undefined, res, next);

    expect(headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin-allow-popups",
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not replace an upstream opener policy", () => {
    const headers = new Map<string, string>([
      ["Cross-Origin-Opener-Policy", "same-origin"],
    ]);
    const res = {
      hasHeader: (name: string) => headers.has(name),
      setHeader: (name: string, value: string) => headers.set(name, value),
    };

    applyBaselineSecurityHeaders(undefined, res, jest.fn());

    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });
});
