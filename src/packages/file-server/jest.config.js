const { readdirSync } = require("node:fs");

/** @type {import('ts-jest').JestConfigWithTsJest} */
const isLinux = process.platform === "linux";
const HOST_DEPENDENT_BTRFS_TESTS =
  "/btrfs/test/(?!rustic-progress\\.test\\.ts$)";

function hasLoopbackDevices() {
  if (!isLinux) return false;
  try {
    return readdirSync("/dev").some((name) => /^loop\d+$/.test(name));
  } catch {
    return false;
  }
}

const testPathIgnorePatterns = !isLinux
  ? ["/btrfs/test/"]
  : hasLoopbackDevices()
    ? []
    : [HOST_DEPENDENT_BTRFS_TESTS];

module.exports = {
  preset: "ts-jest",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  testEnvironment: "node",
  setupFiles: ["./test/setup.js"],
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  testPathIgnorePatterns,
  passWithNoTests: !isLinux,
  maxConcurrency: 1,
  moduleNameMapper: {
    "^@cocalc/backend/(.*)$": "<rootDir>/../backend/$1",
  },
};
