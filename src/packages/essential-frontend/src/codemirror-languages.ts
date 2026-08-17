/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { Extension } from "@codemirror/state";
import type { UltraliteLanguage } from "./code-language";

function loadChunk(
  language: UltraliteLanguage,
  path: string,
): Promise<Extension> {
  return new Promise((resolve, reject) => {
    switch (language) {
      case "bash":
        require.ensure(
          [],
          () => {
            const { StreamLanguage } = require("@codemirror/language");
            const { shell } = require("@codemirror/legacy-modes/mode/shell");
            resolve(StreamLanguage.define(shell));
          },
          reject,
          "ultralite-cm-bash",
        );
        break;
      case "c":
      case "cpp":
        require.ensure(
          [],
          () => resolve(require("@codemirror/lang-cpp").cpp()),
          reject,
          "ultralite-cm-cpp",
        );
        break;
      case "css":
        require.ensure(
          [],
          () => resolve(require("@codemirror/lang-css").css()),
          reject,
          "ultralite-cm-css",
        );
        break;
      case "go":
        require.ensure(
          [],
          () => resolve(require("@codemirror/lang-go").go()),
          reject,
          "ultralite-cm-go",
        );
        break;
      case "javascript":
      case "typescript":
        require.ensure(
          [],
          () =>
            resolve(
              require("@codemirror/lang-javascript").javascript({
                jsx: /\.[jt]sx$/i.test(path),
                typescript: language === "typescript",
              }),
            ),
          reject,
          "ultralite-cm-javascript",
        );
        break;
      case "json":
        require.ensure(
          [],
          () => resolve(require("@codemirror/lang-json").json()),
          reject,
          "ultralite-cm-json",
        );
        break;
      case "latex":
        require.ensure(
          [],
          () => {
            const { StreamLanguage } = require("@codemirror/language");
            const { stex } = require("@codemirror/legacy-modes/mode/stex");
            resolve(StreamLanguage.define(stex));
          },
          reject,
          "ultralite-cm-latex",
        );
        break;
      case "markdown":
        require.ensure(
          [],
          () => resolve(require("@codemirror/lang-markdown").markdown()),
          reject,
          "ultralite-cm-markdown",
        );
        break;
      case "markup":
        require.ensure(
          [],
          () => resolve(require("@codemirror/lang-html").html()),
          reject,
          "ultralite-cm-html",
        );
        break;
      case "python":
        require.ensure(
          [],
          () => resolve(require("@codemirror/lang-python").python()),
          reject,
          "ultralite-cm-python",
        );
        break;
      case "r":
        require.ensure(
          [],
          () => {
            const { StreamLanguage } = require("@codemirror/language");
            const { r } = require("@codemirror/legacy-modes/mode/r");
            resolve(StreamLanguage.define(r));
          },
          reject,
          "ultralite-cm-r",
        );
        break;
      case "rust":
        require.ensure(
          [],
          () => resolve(require("@codemirror/lang-rust").rust()),
          reject,
          "ultralite-cm-rust",
        );
        break;
      case "sql":
        require.ensure(
          [],
          () => resolve(require("@codemirror/lang-sql").sql()),
          reject,
          "ultralite-cm-sql",
        );
        break;
      case "yaml":
        require.ensure(
          [],
          () => {
            const { StreamLanguage } = require("@codemirror/language");
            const { yaml } = require("@codemirror/legacy-modes/mode/yaml");
            resolve(StreamLanguage.define(yaml));
          },
          reject,
          "ultralite-cm-yaml",
        );
        break;
    }
  });
}

export async function loadCodeMirrorLanguage(
  language: UltraliteLanguage | undefined,
  path: string,
): Promise<Extension> {
  return language ? await loadChunk(language, path) : [];
}
