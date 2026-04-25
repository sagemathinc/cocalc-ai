const {
  HOST_DEPENDENT_BTRFS_TESTS,
  shouldRunHostDependentBtrfsTests,
} = require("./jest.helpers.js");

/** @type {import('ts-jest').JestConfigWithTsJest} */
const isLinux = process.platform === "linux";
const testPathIgnorePatterns = !isLinux
  ? ["/btrfs/test/"]
  : shouldRunHostDependentBtrfsTests()
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
