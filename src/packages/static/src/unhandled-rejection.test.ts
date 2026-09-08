import { unhandledRejectionDetails } from "./unhandled-rejection";

describe("unhandled rejection diagnostics", () => {
  it("preserves the message missing from Safari's frame-only stack", () => {
    const stack = "connect@https://cocalc.test/static/editor.js:188:402219";
    expect(
      unhandledRejectionDetails({ name: "Error", message: "closed", stack }),
    ).toEqual({
      message: `unhandledrejection: Error: closed\n${stack}`,
      stack,
    });
  });

  it("does not duplicate the message already present in a Chrome stack", () => {
    const stack = "TypeError: missing store\n    at render (app.js:1:2)";
    expect(
      unhandledRejectionDetails({
        name: "TypeError",
        message: "missing store",
        stack,
      }),
    ).toEqual({
      message: `unhandledrejection: ${stack}`,
      stack,
    });
  });

  it("supports cross-realm error-like values and errors without stacks", () => {
    expect(
      unhandledRejectionDetails({ message: "denied", stack: "f@app.js:1:2" })
        .message,
    ).toBe("unhandledrejection: denied\nf@app.js:1:2");
    expect(
      unhandledRejectionDetails({ name: "Error", message: "timeout" }),
    ).toEqual({
      message: "unhandledrejection: Error: timeout",
      stack: undefined,
    });
  });

  it.each([null, undefined, "closed", 0, false])(
    "handles primitive rejection %p",
    (reason) => {
      expect(unhandledRejectionDetails(reason).message).toBe(
        `unhandledrejection: ${reason == null ? "<no reason>" : String(reason)}`,
      );
    },
  );

  it("retains opaque stacks and bounds object-only fallback diagnostics", () => {
    expect(unhandledRejectionDetails({ stack: "f@app.js:1:2" }).stack).toBe(
      "f@app.js:1:2",
    );
    expect(
      unhandledRejectionDetails({ detail: "x".repeat(2000) }).message.length,
    ).toBeLessThan(1100);
    const circular: any = {};
    circular.self = circular;
    expect(unhandledRejectionDetails(circular).message).toBe(
      "unhandledrejection: <unserializable rejection>",
    );
  });
});
