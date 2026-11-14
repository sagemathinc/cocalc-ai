/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  testEnvironment: "node",
  // Recycle workers between suites instead of accumulating module state across
  // the whole server run, which otherwise outgrows a 16 GB CI runner.
  workerIdleMemoryLimit: "1GB",
  setupFiles: ["./test/setup.js"], // Path to your setup file
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  transformIgnorePatterns: [
    "/node_modules/(?!micro-key-producer|@noble/curves|@noble/hashes)",
  ],
  // Ignore compiled output so Jest does not see duplicate mocks in dist/.
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
  moduleNameMapper: {
    "^micro-key-producer/(.*)$":
      "<rootDir>/test/__mocks__/micro-key-producer/$1",
    "^package-directory$": "<rootDir>/test/__mocks__/package-directory.js",
    "^@cocalc/backend/(.*)$": "<rootDir>/../backend/$1",
    "^@cocalc/server$": "<rootDir>/index.ts",
    "^@cocalc/server/(.*)$": "<rootDir>/$1",
  },
};
