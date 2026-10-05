import {
  isBrowserExtensionError,
  isIgnorableBrowserError,
  isIgnorableUnhandledRejection,
  isOpaqueCrossOriginScriptError,
} from "./webapp-error-filter";

describe("isIgnorableBrowserError", () => {
  test.each([
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
    "ChunkLoadError: Loading chunk 123 failed",
    "Failed to load create project dialog after 3 attempts: Loading CSS chunk 4 failed",
  ])("ignores the browser-generated delivery warning %p", (message) => {
    expect(isIgnorableBrowserError(message)).toBe(true);
  });

  test.each([
    "TypeError: ResizeObserver callback failed",
    "ResizeObserver loop completed with undelivered notifications: callback failed",
    new Error("ResizeObserver loop limit exceeded"),
    undefined,
  ])("preserves real or malformed errors %p", (message) => {
    expect(isIgnorableBrowserError(message)).toBe(false);
  });
});

describe("isBrowserExtensionError", () => {
  it.each([
    { file: "chrome-extension://abc/content.js" },
    { stacktrace: "at inject (moz-extension://abc/inject.js:1:2)" },
    { stacktrace: "global code@safari-web-extension://abc/script.js:1:2" },
  ])("ignores errors originating in extensions: %p", (value) => {
    expect(isBrowserExtensionError(value)).toBe(true);
  });

  it("preserves CoCalc errors that only mention an extension in the message", () => {
    expect(
      isBrowserExtensionError({
        file: "https://cocalc.ai/static/app.js",
        stacktrace: "Error: failed to communicate with chrome extension",
      }),
    ).toBe(false);
  });
});

describe("isIgnorableUnhandledRejection", () => {
  const metaMaskError = new Error("Failed to connect to MetaMask");
  metaMaskError.stack =
    "Error: Failed to connect to MetaMask\n" +
    "    at Object.connect (chrome-extension://extension-id/scripts/inpage.js:7:84179)";
  const conatTimeout = Object.assign(new Error("timeout"), { code: 408 });
  const conatStringTimeout = Object.assign(new Error("timeout"), {
    code: "408",
  });
  const conatSubjectTimeout = Object.assign(
    new Error(
      "timeout - Error: operation has timed out subject:jupyter.project-id.server",
    ),
    { code: 408 },
  );

  test.each([
    new Error(
      "rootfs is not mounted; cannot access absolute path '/home'. Start the project and try again.",
    ),
    new Error(
      "unable to route 'ProjectActions.fs' to project-host for project 00000000-0000-4000-8000-000000000000; host routing info unavailable",
    ),
    new Error('once: timeout of 4000ms waiting for "info"'),
    new Error("socket has been disconnected"),
    "Error: socket has been disconnected",
    new Error("disconnected"),
    "Error: disconnected",
    new Error('once: "info" not emitted before "closed"'),
    new Error("once: 'ready' not emitted before 'closed'"),
    new Error("request timed out"),
    "Error: request timed out",
    conatTimeout,
    conatStringTimeout,
    conatSubjectTimeout,
    new Error("file server not initialized"),
    new Error(
      "account 'account-id' is not a collaborator on project 'project-id'",
    ),
    metaMaskError,
    new Error(
      'COCALC_RUNTIME_SPONSOR_DENIAL:{"code":"runtime_sponsor_slots_exhausted","sponsor_account_id":"00000000-0000-4000-8000-000000000001","limit":1,"current":1,"active_projects":[]}',
    ),
  ])("ignores an expected non-actionable rejection", (reason) => {
    expect(isIgnorableUnhandledRejection(reason)).toBe(true);
  });

  test.each([
    new DOMException(
      "Skipping view transition because viewport size changed.",
      "InvalidStateError",
    ),
    new DOMException(
      "Transition was aborted because of invalid state. Viewport size changed",
      "InvalidStateError",
    ),
    new DOMException("Transition was skipped", "AbortError"),
  ])("ignores a skipped page transition %p", (reason) => {
    expect(isIgnorableUnhandledRejection(reason)).toBe(true);
  });

  it("still reports other errors that mention view transitions", () => {
    expect(
      isIgnorableUnhandledRejection(
        new TypeError("view transition handler is not a function"),
      ),
    ).toBe(false);
  });

  test.each([
    new Error("permission denied"),
    new Error("unable to route billing request"),
    new Error('once: timeout of 4000ms waiting for "ready"'),
    new Error("socket has been disconnected while saving a document"),
    "Error: socket has been disconnected while saving a document",
    new Error("disconnected while saving a document"),
    new Error('once: "info" not emitted before "closed unexpectedly"'),
    new Error("request timed out while saving a document"),
    "Error: request timed out while saving a document",
    new Error("timeout"),
    Object.assign(new Error("timeout"), { code: 500 }),
    Object.assign(new Error("timeout - operation failed without a subject"), {
      code: 408,
    }),
    new Error("file server failed to initialize"),
    new Error("account is not a collaborator"),
    new Error("Failed to connect to MetaMask"),
    new Error("COCALC_RUNTIME_SPONSOR_DENIAL:not-json"),
    "rootfs is not mounted",
    undefined,
  ])("preserves an actionable rejection %p", (reason) => {
    expect(isIgnorableUnhandledRejection(reason)).toBe(false);
  });
});

describe("isOpaqueCrossOriginScriptError", () => {
  it("ignores Safari's detail-free cross-origin script error", () => {
    expect(
      isOpaqueCrossOriginScriptError({
        message: "Script error.",
        error: null,
        filename: "",
        lineNumber: 0,
      }),
    ).toBe(true);
  });

  test.each([
    {
      message: "Script error.",
      error: new Error("Script error."),
      filename: "",
      lineNumber: 0,
    },
    {
      message: "Script error.",
      error: null,
      filename: "https://cocalc.ai/app.js",
      lineNumber: 0,
    },
    {
      message: "Script error.",
      error: null,
      filename: "",
      lineNumber: 42,
    },
    {
      message: "TypeError: script failed",
      error: null,
      filename: "",
      lineNumber: 0,
    },
  ])("preserves an error with actionable details: %p", (event) => {
    expect(isOpaqueCrossOriginScriptError(event)).toBe(false);
  });
});
