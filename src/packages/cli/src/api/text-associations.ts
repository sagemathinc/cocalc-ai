import { basename } from "node:path";

import { filename_extension } from "@cocalc/util/misc";

export type SyncDocDoctype = "syncstring" | "syncdb" | "immer";

const STRUCTURED_EXTENSION_DOCTYPES: Record<string, SyncDocDoctype> = {
  tasks: "syncdb",
  board: "syncdb",
  slides: "syncdb",
  chat: "immer",
  "sage-chat": "immer",
  "cocalc-crm": "syncdb",
};

const CODEMIRROR_ASSOCIATIONS: Record<string, string> = {
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
  mojo: "mojo",
  "🔥": "mojo",
} as const;

const FILENAME_ASSOCIATIONS: Record<
  string,
  { mode: string; name: string; icon?: string; editorHint?: string }
> = {
  dockerfile: {
    mode: "dockerfile",
    name: "Dockerfile",
    icon: "docker",
    editorHint: "codemirror",
  },
  containerfile: {
    mode: "dockerfile",
    name: "Containerfile",
    icon: "docker",
    editorHint: "codemirror",
  },
  makefile: {
    mode: "text/x-makefile",
    name: "Makefile",
    icon: "file-code",
    editorHint: "codemirror",
  },
};

const MODE_TO_ICON: Record<string, string> = {
  python: "python",
  coffeescript: "coffee",
  javascript: "js-square",
  jsx: "node-js",
  "application/typescript": "js-square",
  "text/typescript-jsx": "node-js",
  "text/x-rustsrc": "cog",
  r: "r",
  rmd: "r",
  "text/x-gas": "microchip",
  shell: "terminal",
  dockerfile: "docker",
};

export interface TextDocumentAssociation {
  basename: string;
  extension: string | null;
  doctype: SyncDocDoctype;
  supportsTextApi: boolean;
  editorHint: string | null;
  mode: string | null;
  icon: string | null;
  name: string;
}

function modeName(mode: string): string {
  let name = mode;
  const i = name.indexOf("x-");
  if (i !== -1) {
    name = name.slice(i + 2);
  }
  return name.replace("src", "");
}

function resolveDoctype(path: string): SyncDocDoctype {
  const ext = filename_extension(path).toLowerCase();
  return STRUCTURED_EXTENSION_DOCTYPES[ext] ?? "syncstring";
}

export function resolveTextDocumentAssociation(path: string): TextDocumentAssociation {
  const base = basename(path);
  const ext = filename_extension(path);
  const doctype = resolveDoctype(path);
  const byName = FILENAME_ASSOCIATIONS[base.toLowerCase()];
  const mode = byName?.mode ?? (ext ? CODEMIRROR_ASSOCIATIONS[ext] : undefined);
  const name = byName?.name ?? (mode ? modeName(mode) : ext ? ext.toUpperCase() : "Text");
  const editorHint =
    byName?.editorHint ?? (mode ? "codemirror" : doctype === "syncstring" ? "text" : null);
  const icon =
    byName?.icon ?? (mode ? MODE_TO_ICON[mode] ?? "file-code" : doctype === "syncstring" ? "file" : null);
  return {
    basename: base,
    extension: ext || null,
    doctype,
    supportsTextApi: doctype === "syncstring",
    editorHint,
    mode: mode ?? null,
    icon,
    name,
  };
}
