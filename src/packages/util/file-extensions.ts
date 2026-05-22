/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Shared extension predicates for server and frontend code. Keep this file free
of frontend-only icon/editor registrations so API packages can depend on it.
*/

const image = new Set([
  "png",
  "jpg",
  "gif",
  "svg",
  "jpeg",
  "bmp",
  "apng",
  "ico",
]);

export const isImage = (ext: string): boolean => image.has(ext);

const pdf = new Set(["pdf"]);
export const isPDF = (ext: string): boolean => pdf.has(ext);

const html = new Set(["html", "htm"]);
export const isHTML = (ext: string): boolean => html.has(ext);

// what to render in markdown: md and rmd
// TODO: normal markdown doesn't know how the fenced block modes
// work with rmd! One fix would use the Slate renderer.
const md = new Set(["md", "rmd"]);
export const isMarkdown = (ext: string): boolean => md.has(ext);

export const CODEMIRROR_MODES = {
  adb: "ada",
  asm: "text/x-gas",
  bash: "shell",
  c: "text/x-c",
  cu: "text/x-c",
  zig: "text/x-c",
  "c++": "text/x-c++src",
  cob: "text/x-cobol",
  cql: "text/x-sql",
  cpp: "text/x-c++src",
  cc: "text/x-c++src",
  tcc: "text/x-c++src",
  cjs: "javascript",
  conf: "nginx",
  csharp: "text/x-csharp",
  "c#": "text/x-csharp",
  clj: "text/x-clojure",
  cljs: "text/x-clojure",
  cljc: "text/x-clojure",
  edn: "text/x-clojure",
  elm: "text/x-elm",
  env: "shell",
  erl: "text/x-erlang",
  hrl: "text/x-erlang",
  cjsx: "text/cjsx",
  coffee: "coffeescript",
  css: "css",
  diff: "text/x-diff",
  dtd: "application/xml-dtd",
  e: "text/x-eiffel",
  ecl: "ecl",
  f: "text/x-fortran",
  f90: "text/x-fortran",
  f95: "text/x-fortran",
  h: "text/x-c++hdr",
  hpp: "text/x-c++hdr",
  hs: "text/x-haskell",
  ini: "text/x-ini",
  lhs: "text/x-haskell",
  html: "htmlmixed",
  init: "shell",
  java: "text/x-java",
  jl: "text/x-julia",
  javascript: "javascript",
  js: "javascript",
  jsx: "jsx",
  json: "javascript",
  jsonl: "javascript",
  ls: "text/x-livescript",
  lua: "lua",
  m: "text/x-octave",
  md: "yaml-frontmatter",
  mjs: "javascript",
  ml: "text/x-ocaml",
  mysql: "text/x-sql",
  psql: "text/x-sql",
  patch: "text/x-diff",
  gp: "text/pari",
  go: "text/x-go",
  pari: "text/pari",
  pegjs: "pegjs",
  php: "php",
  pl: "text/x-perl",
  py: "python",
  python3: "python",
  pyx: "python",
  r: "r",
  R: "r",
  rmd: "rmd",
  qmd: "rmd",
  rnw: "rnw",
  rtex: "rtex",
  rs: "text/x-rustsrc",
  rst: "rst",
  rb: "text/x-ruby",
  ru: "text/x-ruby",
  sage: "python",
  scala: "text/x-scala",
  scm: "text/x-scheme",
  sh: "shell",
  spyx: "python",
  sql: "text/x-sql",
  ss: "text/x-scheme",
  sty: "stex2",
  txt: "text",
  tex: "stex2",
  ts: "application/typescript",
  tsx: "text/typescript-jsx",
  typescript: "application/typescript",
  toml: "text/x-toml",
  bib: "stex",
  bbl: "stex",
  xml: "xml",
  cml: "xml",
  kml: "xml",
  xsl: "xml",
  ptx: "xml",
  v: "verilog",
  vh: "verilog",
} as const;

const EXTRA_CODE_VIEWER_MODES: Record<string, string> = {
  "🔥": "mojo",
  mojo: "mojo",
  latex: "stex2",
  s: "gas",
  lisp: "commonlisp",
  lsp: "commonlisp",
  el: "commonlisp",
  cl: "commonlisp",
  yaml: "yaml",
  yml: "yaml",
  pug: "text/x-pug",
  jade: "text/x-pug",
  make: "makefile",
  build: "makefile",
};

export function codemirrorMode(ext: string): { name: string } | undefined {
  const name =
    CODEMIRROR_MODES[ext as keyof typeof CODEMIRROR_MODES] ??
    EXTRA_CODE_VIEWER_MODES[ext];
  return name == null ? undefined : { name };
}

export function isCodemirror(ext: string): boolean {
  return codemirrorMode(ext) != null;
}

// Has a special viewer -- not the sort of file that could
// just be embedded via html (e.g., NOT an image).
export function hasSpecialViewer(ext: string): boolean {
  return (
    ext === "ipynb" ||
    ext === "board" ||
    ext == "slides" ||
    isMarkdown(ext) ||
    isCodemirror(ext) ||
    isHTML(ext)
  );
}

export function hasViewer(ext: string): boolean {
  return hasSpecialViewer(ext) || isImage(ext) || isPDF(ext);
}

// If the viewer isn't specified, definitely, always default
// raw for these file types.
export function defaultToRaw(ext: string): boolean {
  if (ext === "css" || ext == "js") return true;
  return false;
}
