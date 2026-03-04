/** @type {import('ts-jest').JestConfigWithTsJest} */
const isLinux = process.platform === "linux";

module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["./test/setup.js"],
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  testPathIgnorePatterns: isLinux ? [] : ["/btrfs/test/"],
  passWithNoTests: !isLinux,
  maxConcurrency: 1,
  moduleNameMapper: {
    "^@cocalc/backend/(.*)$": "<rootDir>/../backend/$1",
  },
};
