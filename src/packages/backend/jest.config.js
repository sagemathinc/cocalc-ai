/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  testEnvironment: "node",
  setupFiles: ["./test/setup.js"],
  setupFilesAfterEnv: ["./test/setup-after-env.js"],
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  // Allow package-style imports (e.g., @cocalc/backend/conat/test/setup) to
  // resolve directly to the source tree during tests.
  moduleNameMapper: {
    "^@cocalc/backend/(.*)$": "<rootDir>/$1",
    "^@cocalc/conat/(.*)$": "<rootDir>/../conat/$1",
  },
};
