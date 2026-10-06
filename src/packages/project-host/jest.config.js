/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/../backend/test/setup.js"],
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
  moduleNameMapper: {
    "^@cocalc/backend/conat/test/(.*)$": "<rootDir>/../backend/conat/test/$1",
    "^@cocalc/backend/podman/conmon$": "<rootDir>/../backend/podman/conmon.ts",
  },
};
