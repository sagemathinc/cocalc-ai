/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  testEnvironmentOptions: {
    // needed or jest imports the ts directly rather than the compiled
    // dist exported from our package.json. Without this imports won't work.
    // See https://jestjs.io/docs/configuration#testenvironment-string
    customExportConditions: ["node", "node-addons"],
  },
  moduleNameMapper: {
    "^@cocalc/frontend/codemirror/static$":
      "<rootDir>/test/mocks/codemirror-static.js",
    "^@cocalc/frontend/codemirror/init$":
      "<rootDir>/test/mocks/codemirror-init.js",
    "^@cocalc/frontend/frame-editors/latex-editor/actions$":
      "<rootDir>/test/mocks/latex-actions.js",
    "^@cocalc/frontend/users$": "<rootDir>/test/mocks/frontend-users.js",
    "^@cocalc/frontend/frame-editors/generic/chat$":
      "<rootDir>/test/mocks/generic-chat.js",
    "^@cocalc/frontend/(.*)$": "<rootDir>/$1",
    "^p-limit$": "<rootDir>/test/mocks/p-limit.js",
    "^dropzone$": "<rootDir>/test/mocks/dropzone.js",
    "^\\.\\./users$": "<rootDir>/test/mocks/frontend-users.js",
    "^\\.\\./\\.\\./users$": "<rootDir>/test/mocks/frontend-users.js",
    "^\\.\\./generic/chat$": "<rootDir>/test/mocks/generic-chat.js",
    "^@xterm/xterm$": "<rootDir>/test/mocks/xterm.js",
    "^@xterm/addon-fit$": "<rootDir>/test/mocks/xterm-addon.js",
    "^@xterm/addon-web-links$": "<rootDir>/test/mocks/xterm-addon.js",
    "^@xterm/addon-webgl$": "<rootDir>/test/mocks/xterm-addon.js",
    "^\\.\\./time-travel-editor/actions$":
      "<rootDir>/test/mocks/time-travel-actions.js",
    "^pdfjs-dist$": "<rootDir>/test/mocks/pdfjs.js",
    "^pdfjs-dist/webpack\\.mjs$": "<rootDir>/test/mocks/pdfjs-webpack.js",
    "\\.(css|less|sass|scss)$": "<rootDir>/test/mocks/style.js",
    "\\.txt$": "<rootDir>/test/mocks/text.js",
  },
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  testPathIgnorePatterns: [
    "<rootDir>/editors/slate/playwright/",
    "<rootDir>/chat/playwright/",
  ],
  setupFilesAfterEnv: ["./test/setup.js"],
};
