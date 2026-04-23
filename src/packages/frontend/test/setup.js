require("@testing-library/jest-dom");
process.env.COCALC_TEST_MODE = true;

// polyfill TextEncoder so we can run tests using nodej.s
const { TextEncoder, TextDecoder } = require("util");
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// In production builds DEBUG is injected by the bundler. For tests, default to false.
global.DEBUG = false;

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query) => ({
      addEventListener: jest.fn(),
      addListener: jest.fn(),
      dispatchEvent: jest.fn(),
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: jest.fn(),
      removeListener: jest.fn(),
    }),
  });
}

if (typeof global.ResizeObserver === "undefined") {
  const ResizeObserver = class ResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  };
  global.ResizeObserver = ResizeObserver;
  if (typeof window !== "undefined") {
    window.ResizeObserver = ResizeObserver;
  }
}

// Minimal jQuery stub for bootstrap-fixes and related side effects in tests.
global.$ = function () {
  return {
    on: () => {},
    off: () => {},
    remove: () => {},
    addClass: () => {},
    removeClass: () => {},
    append: () => {},
    attr: () => {},
    css: () => {},
    text: () => {},
    html: () => {},
    val: () => {},
    length: 0,
  };
};
global.jQuery = global.$;

// Provide a lightweight mock for the lite runtime flags used across the frontend.
jest.mock(
  "@cocalc/frontend/lite",
  () => ({
    lite: false,
    project_id: "",
    account_id: "",
  }),
  { virtual: true },
);

afterAll(() => {
  try {
    const { webapp_client } = require("@cocalc/frontend/webapp-client");
    webapp_client?.conat_client?.permanentlyDisconnect?.();
  } catch {
    // Some tests replace the webapp client module; there is nothing to clean up.
  }
});
