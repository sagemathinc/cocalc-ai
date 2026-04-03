const { spawnSync } = require("node:child_process");

/** @type {import('ts-jest').JestConfigWithTsJest} */
const JUPYTER_INTEGRATION_TESTS = ["/kernel/test/", "/stateless-api/"];

function hasJupyter() {
  const result = spawnSync("jupyter", ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  setupFiles: ["./test/setup.js"],
  setupFilesAfterEnv: ["./test/setup-after-env.js"],
  testPathIgnorePatterns: hasJupyter() ? [] : JUPYTER_INTEGRATION_TESTS,
};
