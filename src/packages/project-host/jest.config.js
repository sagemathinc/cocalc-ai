/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/../backend/test/setup.js"],
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
  // @sagemathinc/sagebrush-board is ESM only: compile it for jest's CommonJS
  // module system (the runtime loads it with Node's own ESM support).
  transform: {
    "^.+\\.tsx?$": "ts-jest",
    "sagebrush-board/dist/.+\\.js$": [
      "ts-jest",
      {
        tsconfig: { allowJs: true, module: "commonjs" },
        isolatedModules: true,
      },
    ],
  },
  transformIgnorePatterns: [
    "/node_modules/(?!(\\.pnpm/@sagemathinc\\+sagebrush-board|@sagemathinc/sagebrush-board/))",
  ],
  moduleNameMapper: {
    "^@cocalc/backend/conat/test/(.*)$": "<rootDir>/../backend/conat/test/$1",
    "^@cocalc/backend/conat/files/test/(.*)$":
      "<rootDir>/../backend/conat/files/test/$1",
    "^@cocalc/backend/podman/conmon$": "<rootDir>/../backend/podman/conmon.ts",
    // Its "exports" offer only "import", which jest's CommonJS resolver skips.
    "^@sagemathinc/sagebrush-board$":
      "<rootDir>/node_modules/@sagemathinc/sagebrush-board/dist/index.js",
    "^@sagemathinc/sagebrush-board/submission$":
      "<rootDir>/node_modules/@sagemathinc/sagebrush-board/dist/submission.js",
  },
};
