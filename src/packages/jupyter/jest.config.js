const { spawnSync } = require("node:child_process");

/** @type {import('ts-jest').JestConfigWithTsJest} */
const JUPYTER_INTEGRATION_TESTS = ["/kernel/test/", "/stateless-api/"];

function hasJupyter() {
  const result = spawnSync("jupyter", ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

// Without jupyter the kernel suites are skipped, except where ZMTP_REQUIRE_PYZMQ=1 (CI)
// requires the Python stack: there a missing jupyter is an error, not a silent skip.
function jupyterTestsIgnored() {
  if (hasJupyter()) return [];
  if (process.env.ZMTP_REQUIRE_PYZMQ === "1") {
    throw new Error(
      "ZMTP_REQUIRE_PYZMQ=1, but `jupyter --version` fails: the kernel suites can't run",
    );
  }
  return JUPYTER_INTEGRATION_TESTS;
}

module.exports = {
  preset: "ts-jest",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  testEnvironment: "node",
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  setupFiles: ["./test/setup.js"],
  setupFilesAfterEnv: ["./test/setup-after-env.js"],
  testPathIgnorePatterns: jupyterTestsIgnored(),
};
