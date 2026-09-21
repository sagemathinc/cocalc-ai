module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.tsx"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          rootDir: ".",
          ignoreDeprecations: "6.0",
          module: "commonjs",
          jsx: "react-jsx",
          esModuleInterop: true,
          types: ["jest", "node"],
          isolatedModules: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    "^react-native$": "<rootDir>/test/react-native.cjs",
    "^react-native-safe-area-context$": "<rootDir>/test/safe-area.cjs",
  },
};
