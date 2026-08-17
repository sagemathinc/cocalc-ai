/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import Prism from "prismjs/components/prism-core";
import type { UltraliteLanguage } from "./code-language";

export type { UltraliteLanguage } from "./code-language";

function loadChunk(name: UltraliteLanguage): Promise<void> {
  return new Promise((resolve, reject) => {
    switch (name) {
      case "bash":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-bash");
            resolve();
          },
          reject,
          "ultralite-prism-bash",
        );
        break;
      case "c":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-clike");
            require("prismjs/components/prism-c");
            resolve();
          },
          reject,
          "ultralite-prism-c",
        );
        break;
      case "cpp":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-clike");
            require("prismjs/components/prism-c");
            require("prismjs/components/prism-cpp");
            resolve();
          },
          reject,
          "ultralite-prism-cpp",
        );
        break;
      case "css":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-css");
            resolve();
          },
          reject,
          "ultralite-prism-css",
        );
        break;
      case "go":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-clike");
            require("prismjs/components/prism-go");
            resolve();
          },
          reject,
          "ultralite-prism-go",
        );
        break;
      case "javascript":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-clike");
            require("prismjs/components/prism-javascript");
            resolve();
          },
          reject,
          "ultralite-prism-javascript",
        );
        break;
      case "json":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-json");
            resolve();
          },
          reject,
          "ultralite-prism-json",
        );
        break;
      case "latex":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-latex");
            resolve();
          },
          reject,
          "ultralite-prism-latex",
        );
        break;
      case "markdown":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-markup");
            require("prismjs/components/prism-markdown");
            resolve();
          },
          reject,
          "ultralite-prism-markdown",
        );
        break;
      case "markup":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-markup");
            resolve();
          },
          reject,
          "ultralite-prism-markup",
        );
        break;
      case "python":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-python");
            resolve();
          },
          reject,
          "ultralite-prism-python",
        );
        break;
      case "r":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-r");
            resolve();
          },
          reject,
          "ultralite-prism-r",
        );
        break;
      case "rust":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-rust");
            resolve();
          },
          reject,
          "ultralite-prism-rust",
        );
        break;
      case "sql":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-sql");
            resolve();
          },
          reject,
          "ultralite-prism-sql",
        );
        break;
      case "typescript":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-clike");
            require("prismjs/components/prism-javascript");
            require("prismjs/components/prism-typescript");
            resolve();
          },
          reject,
          "ultralite-prism-typescript",
        );
        break;
      case "yaml":
        require.ensure(
          [],
          () => {
            require("prismjs/components/prism-yaml");
            resolve();
          },
          reject,
          "ultralite-prism-yaml",
        );
        break;
    }
  });
}

export async function loadLanguage(
  language?: UltraliteLanguage,
): Promise<Prism.Grammar | undefined> {
  if (!language) return;
  if (!Prism.languages[language]) await loadChunk(language);
  return Prism.languages[language];
}

export { Prism };
