import { readFileSync } from "fs";
import { join } from "path";
import { runInNewContext } from "vm";
import { unhandledRejectionDetails } from "./unhandled-rejection";

it.each([
  "connect@https://cocalc.test/static/editor.js:188:402219",
  "connect@https://cocalc.test/static/editor.js:188:402219\nfetch@chrome-extension://example/injected.js:1:2",
])(
  "sends the original rejection message and stack without new suppression: %s",
  async (stack) => {
    const handlers = new Map<string, (event: unknown) => void>();
    const send = jest.fn().mockResolvedValue(undefined);
    const requires = {
      "./unhandled-rejection": { unhandledRejectionDetails },
      "./webapp-error-filter": {
        isBrowserExtensionError: ({ stacktrace }) =>
          /chrome-extension:/.test(stacktrace),
        isIgnorableBrowserError: () => false,
        isIgnorableUnhandledRejection: () => false,
      },
      "@cocalc/frontend/app/react-error-reporting": {
        COCALC_REACT_ERROR_EVENT: "cocalc:react-error",
      },
      "@cocalc/util/misc": {
        defaults: (opts) => opts,
        uuidsha1: () => "fingerprint",
        get_uptime: () => "1s",
        get_start_time_ts: () => 0,
      },
      "@cocalc/frontend/feature": {
        get_browser: () => "safari",
        IS_MOBILE: false,
      },
      "@cocalc/frontend/webapp-client": {
        webapp_client: { tracking_client: { webapp_error: send } },
      },
    };
    runInNewContext(
      readFileSync(join(__dirname, "webapp-error-reporter.js"), "utf8"),
      {
        require: (name) => {
          if (!(name in requires))
            throw new Error(`unexpected require: ${name}`);
          return requires[name];
        },
        exports: {},
        DEBUG: false,
        BACKEND: false,
        SMC_VERSION: "test",
        BUILD_DATE: "test",
        COCALC_GIT_REVISION: "test",
        navigator: { userAgent: "Safari" },
        window: {
          location: { href: "https://cocalc.test/projects/example" },
          addEventListener: (name, handler) => handlers.set(name, handler),
        },
      },
    );

    const reason = Object.freeze({ name: "Error", message: "closed", stack });
    handlers.get("unhandledrejection")!(Object.freeze({ reason }));
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "unhandledrejection",
        message: `unhandledrejection: Error: closed\n${stack}`,
        stacktrace: stack,
        browser: "safari",
      }),
    );
  },
);
