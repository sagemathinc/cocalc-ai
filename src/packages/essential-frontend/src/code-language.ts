/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export type UltraliteLanguage =
  | "bash"
  | "c"
  | "cpp"
  | "css"
  | "go"
  | "javascript"
  | "json"
  | "latex"
  | "markdown"
  | "markup"
  | "python"
  | "r"
  | "rust"
  | "sql"
  | "typescript"
  | "yaml";

const EXTENSIONS: Record<string, UltraliteLanguage> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  cxx: "cpp",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  htm: "markup",
  html: "markup",
  go: "go",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  latex: "latex",
  md: "markdown",
  py: "python",
  pyw: "python",
  r: "r",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  tex: "latex",
  ts: "typescript",
  tsx: "typescript",
  xhtml: "markup",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
};

const LANGUAGE_NAMES: Record<string, UltraliteLanguage> = {
  ...EXTENSIONS,
  "c++": "cpp",
  golang: "go",
  javascript: "javascript",
  markdown: "markdown",
  markup: "markup",
  node: "javascript",
  python: "python",
  python3: "python",
  sage: "python",
  shell: "bash",
  typescript: "typescript",
};

export function languageForName(value: string): UltraliteLanguage | undefined {
  let name = value.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
  if (name.startsWith("{") && name.endsWith("}")) name = name.slice(1, -1);
  name = name.replace(/^language-/, "").replace(/^\./, "");
  return LANGUAGE_NAMES[name];
}

export function guessCodeLanguage(
  contents: string,
): UltraliteLanguage | undefined {
  const code = contents.trim();
  if (!code) return;
  if (/^[{[]/.test(code)) {
    try {
      JSON.parse(code);
      return "json";
    } catch {
      // Continue with source heuristics.
    }
  }
  if (/<\/?[a-z][^>]*>/i.test(code)) return "markup";
  if (/\\(documentclass|usepackage|begin|end)\b/.test(code)) return "latex";
  if (/^#!.*\b(bash|sh|zsh)\b/m.test(code)) return "bash";
  if (/\bpackage\s+\w+[\s\S]*\bfunc\s+\w+\s*\(/.test(code)) return "go";
  if (/\b(fn\s+\w+|let\s+mut|impl\s+\w+|use\s+\w+::)/.test(code)) {
    return "rust";
  }
  if (
    /\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\b(FROM|INTO|SET)\b/i.test(code)
  ) {
    return "sql";
  }
  if (/#include\b/.test(code)) {
    return /\b(namespace|template|std::|cout\s*<<)\b/.test(code) ? "cpp" : "c";
  }
  if (
    /\b(interface\s+\w+|type\s+\w+\s*=|:\s*(string|number|boolean)\b)/.test(
      code,
    )
  ) {
    return "typescript";
  }
  if (/\b(def\s+\w+|from\s+\w+\s+import|None|self\.|elif\b)/.test(code)) {
    return "python";
  }
  if (/\b(const|let|var|function|console\.log)\b|=>/.test(code)) {
    return "javascript";
  }
  if (/(^|\n)\s*\$\s+\S|\b(sudo|apt|brew|grep|awk|sed)\b/.test(code)) {
    return "bash";
  }
  if (/\b(library|data\.frame)\s*\(|<-/.test(code)) return "r";
  if (/(^|\n)\s*[.#]?[a-z][\w .#:[\]-]*\s*\{[^}]*:[^}]*\}/i.test(code)) {
    return "css";
  }
  return;
}

export function languageForCode(
  info: string,
  contents: string,
): UltraliteLanguage | undefined {
  return languageForName(info) ?? guessCodeLanguage(contents);
}

export function languageForPath(path: string): UltraliteLanguage | undefined {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (["bashrc", "profile", "zshrc"].includes(name.replace(/^\./, ""))) {
    return "bash";
  }
  return EXTENSIONS[name.split(".").pop() ?? ""];
}
