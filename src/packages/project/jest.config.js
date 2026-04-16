/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  testEnvironment: "node",
  setupFiles: ["./test/setup.js"],
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
};
