/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  testEnvironment: "node",
  moduleNameMapper: {
    "^@cocalc/util/(.*)$": "<rootDir>/../util/dist/$1",
  },
  roots: [
    "<rootDir>/hub/acp/__tests__",
    "<rootDir>/hub/acp/executor/__tests__",
  ],
  testMatch: ["**/*.test.ts"],
  maxWorkers: 1,
  transformIgnorePatterns: ["/node_modules/(?!(?:@agentclientprotocol)/)"],
};
