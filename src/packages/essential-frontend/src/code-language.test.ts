/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  guessCodeLanguage,
  languageForCode,
  languageForName,
} from "./code-language";

test("normalizes common explicit language names", () => {
  expect(languageForName("python")).toBe("python");
  expect(languageForName("{.ts}")).toBe("typescript");
  expect(languageForName("shell")).toBe("bash");
  expect(languageForName("sage")).toBe("python");
});

test("infers common unfenced source languages", () => {
  expect(guessCodeLanguage("def f(x):\n    return x + 1")).toBe("python");
  expect(guessCodeLanguage("package main\nfunc main() {}\n")).toBe("go");
  expect(guessCodeLanguage("const value = { answer: 42 };\n")).toBe(
    "javascript",
  );
  expect(languageForCode("", "library(ggplot2)\nx <- 2")).toBe("r");
});

test("prefers an explicit supported mode over heuristics", () => {
  expect(languageForCode("sql", "const value = 1")).toBe("sql");
});
