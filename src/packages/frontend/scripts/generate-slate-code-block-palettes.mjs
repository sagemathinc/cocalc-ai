#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(
  new URL("..", import.meta.url).pathname,
  "..",
  "..",
  "..",
);
const frontendRoot = path.join(repoRoot, "src", "packages", "frontend");
const accountsPath = path.join(
  repoRoot,
  "src",
  "packages",
  "util",
  "db-schema",
  "accounts.ts",
);
const codemirrorThemeDir = path.join(
  frontendRoot,
  "node_modules",
  ".pnpm",
  "codemirror@5.65.21",
  "node_modules",
  "codemirror",
  "theme",
);
const customThemeDir = path.join(
  repoRoot,
  "src",
  "packages",
  "cdn",
  "cm-custom-theme",
);
const outputPath = path.join(
  frontendRoot,
  "editors",
  "slate",
  "elements",
  "code-block",
  "theme-palettes.generated.ts",
);

const COLOR_RE =
  /#(?:[0-9a-fA-F]{3,8})\b|rgba?\([^)]*\)|\b(?:white|black|silver|gray|grey|red|green|blue|yellow|orange|purple|pink|brown|transparent)\b/;
const NAMED = {
  white: "#ffffff",
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  transparent: "rgba(0, 0, 0, 0)",
};

const DEFAULT_PALETTE = {
  mode: "light",
  background: "#ffffff",
  foreground: "#24292e",
  border: "#c0c0c0",
  comment: "#6a737d",
  keyword: "#07a",
  string: "#690",
  number: "#905",
  definition: "#dd4a68",
};

function parseEditorThemeIds(source) {
  const block = source.match(
    /export const EDITOR_COLOR_SCHEMES:[\s\S]*?=\s*\{([\s\S]*?)\n\};/,
  );
  if (!block) throw new Error("failed to locate EDITOR_COLOR_SCHEMES");
  const ids = [];
  for (const match of block[1].matchAll(
    /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:/gm,
  )) {
    ids.push(match[1] ?? match[2] ?? match[3]);
  }
  return ids;
}

function parseRules(css) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]+)\}/g;
  let match;
  while ((match = re.exec(css)) != null) {
    const selectors = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const declarations = {};
    for (const part of match[2].split(";")) {
      const idx = part.indexOf(":");
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim().toLowerCase();
      const value = part.slice(idx + 1).trim();
      if (!key || !value) continue;
      declarations[key] = value;
    }
    if (selectors.length > 0 && Object.keys(declarations).length > 0) {
      rules.push({ selectors, declarations });
    }
  }
  return rules;
}

function extractColor(value) {
  if (!value) return undefined;
  const match = value.match(COLOR_RE);
  if (!match) return undefined;
  const found = match[0].toLowerCase();
  return NAMED[found] ?? match[0];
}

function parseColor(color) {
  if (!color) return undefined;
  const normalized = color.trim().toLowerCase();
  const named = NAMED[normalized];
  if (named && named !== color) return parseColor(named);
  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    return undefined;
  }
  const rgb = normalized.match(/rgba?\(([^)]+)\)/);
  if (!rgb) return undefined;
  const parts = rgb[1]
    .split(",")
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));
  if (parts.some((value) => !Number.isFinite(value))) return undefined;
  return { r: parts[0], g: parts[1], b: parts[2] };
}

function luminance(color) {
  const rgb = parseColor(color);
  if (!rgb) return 1;
  const toLinear = (value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * toLinear(rgb.r) +
    0.7152 * toLinear(rgb.g) +
    0.0722 * toLinear(rgb.b)
  );
}

function mix(colorA, colorB, amount) {
  const a = parseColor(colorA);
  const b = parseColor(colorB);
  if (!a || !b) return colorA;
  const blend = (x, y) => Math.round(x + (y - x) * amount);
  const r = blend(a.r, b.r);
  const g = blend(a.g, b.g);
  const b2 = blend(a.b, b.b);
  return `rgb(${r}, ${g}, ${b2})`;
}

function selectorMatch(selector, all = [], none = []) {
  return (
    all.every((part) => selector.includes(part)) &&
    none.every((part) => !selector.includes(part))
  );
}

function findRule(rules, { all = [], none = [] }) {
  return rules.find((rule) =>
    rule.selectors.some((selector) => selectorMatch(selector, all, none)),
  );
}

function findColorFromRules(rules, descriptors) {
  for (const descriptor of descriptors) {
    const rule = findRule(rules, descriptor.match);
    if (!rule) continue;
    for (const prop of descriptor.props) {
      const value = extractColor(rule.declarations[prop]);
      if (value) return value;
    }
  }
  return undefined;
}

function sourceForTheme(themeId) {
  if (themeId === "default") {
    return null;
  }
  if (themeId === "solarized dark") {
    return {
      filePath: path.join(codemirrorThemeDir, "solarized.css"),
      rootAll: [".cm-s-solarized", ".cm-s-dark"],
      tokenAll: [".cm-s-solarized"],
    };
  }
  if (themeId === "solarized light") {
    return {
      filePath: path.join(codemirrorThemeDir, "solarized.css"),
      rootAll: [".cm-s-solarized", ".cm-s-light"],
      tokenAll: [".cm-s-solarized"],
    };
  }
  if (themeId === "cocalc-dark" || themeId === "cocalc-light") {
    return {
      filePath: path.join(customThemeDir, `${themeId}.css`),
      rootAll: [`.cm-s-${themeId}`],
      tokenAll: [`.cm-s-${themeId}`],
    };
  }
  return {
    filePath: path.join(codemirrorThemeDir, `${themeId}.css`),
    rootAll: [`.cm-s-${themeId}`],
    tokenAll: [`.cm-s-${themeId}`],
  };
}

function extractPalette(themeId, parsedRulesCache) {
  if (themeId === "default") {
    return DEFAULT_PALETTE;
  }
  const source = sourceForTheme(themeId);
  if (!source || !fs.existsSync(source.filePath)) {
    return DEFAULT_PALETTE;
  }
  const cacheKey = source.filePath;
  let rules = parsedRulesCache.get(cacheKey);
  if (!rules) {
    rules = parseRules(fs.readFileSync(source.filePath, "utf8"));
    parsedRulesCache.set(cacheKey, rules);
  }
  const rootBackground = findColorFromRules(rules, [
    {
      match: {
        all: [...source.rootAll, "CodeMirror"],
        none: [
          "selected",
          "gutters",
          "cursor",
          "activeline",
          "matchingbracket",
          "nonmatchingbracket",
          "selection",
        ],
      },
      props: ["background-color", "background"],
    },
    {
      match: {
        all: [...source.rootAll],
        none: [
          "selected",
          "gutters",
          "cursor",
          "activeline",
          "matchingbracket",
          "nonmatchingbracket",
          "selection",
        ],
      },
      props: ["background-color", "background"],
    },
  ]);
  const rootForeground = findColorFromRules(rules, [
    {
      match: {
        all: [...source.rootAll, "CodeMirror"],
        none: [
          "selected",
          "gutters",
          "cursor",
          "activeline",
          "matchingbracket",
          "nonmatchingbracket",
          "selection",
        ],
      },
      props: ["color"],
    },
    {
      match: {
        all: [...source.rootAll],
        none: [
          "selected",
          "gutters",
          "cursor",
          "activeline",
          "matchingbracket",
          "nonmatchingbracket",
          "selection",
        ],
      },
      props: ["color"],
    },
  ]);
  const background = rootBackground ?? DEFAULT_PALETTE.background;
  const foreground = rootForeground ?? DEFAULT_PALETTE.foreground;
  const mode = luminance(background) < 0.45 ? "dark" : "light";
  const border =
    findColorFromRules(rules, [
      {
        match: { all: [...source.rootAll, "CodeMirror-gutters"], none: [] },
        props: ["border-right-color", "border-right", "border-color", "border"],
      },
      {
        match: { all: [...source.tokenAll, "CodeMirror-gutters"], none: [] },
        props: ["border-right-color", "border-right", "border-color", "border"],
      },
    ]) ?? mix(background, foreground, mode === "dark" ? 0.22 : 0.18);
  const comment =
    findColorFromRules(rules, [
      {
        match: { all: [...source.tokenAll, ".cm-comment"], none: [] },
        props: ["color"],
      },
    ]) ?? mix(foreground, background, mode === "dark" ? 0.35 : 0.45);
  const string =
    findColorFromRules(rules, [
      {
        match: { all: [...source.tokenAll, ".cm-string"], none: [] },
        props: ["color"],
      },
      {
        match: { all: [...source.tokenAll, ".cm-string-2"], none: [] },
        props: ["color"],
      },
    ]) ?? DEFAULT_PALETTE.string;
  const keyword =
    findColorFromRules(rules, [
      {
        match: { all: [...source.tokenAll, ".cm-keyword"], none: [] },
        props: ["color"],
      },
      {
        match: { all: [...source.tokenAll, ".cm-operator"], none: [] },
        props: ["color"],
      },
    ]) ?? DEFAULT_PALETTE.keyword;
  const number =
    findColorFromRules(rules, [
      {
        match: { all: [...source.tokenAll, ".cm-number"], none: [] },
        props: ["color"],
      },
      {
        match: { all: [...source.tokenAll, ".cm-atom"], none: [] },
        props: ["color"],
      },
    ]) ?? DEFAULT_PALETTE.number;
  const definition =
    findColorFromRules(rules, [
      {
        match: { all: [...source.tokenAll, ".cm-def"], none: [".cm-comment"] },
        props: ["color"],
      },
      {
        match: { all: [...source.tokenAll, ".cm-variable-2"], none: [] },
        props: ["color"],
      },
      {
        match: { all: [...source.tokenAll, ".cm-property"], none: [] },
        props: ["color"],
      },
    ]) ?? DEFAULT_PALETTE.definition;
  return {
    mode,
    background,
    foreground,
    border,
    comment,
    keyword,
    string,
    number,
    definition,
  };
}

const themeIds = parseEditorThemeIds(fs.readFileSync(accountsPath, "utf8"));
const parsedRulesCache = new Map();
const palettes = {};
for (const themeId of themeIds) {
  palettes[themeId] = extractPalette(themeId, parsedRulesCache);
}

const output = `/*\n *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.\n *  License: MS-RSL – see LICENSE.md for details\n *\n *  Generated by scripts/generate-slate-code-block-palettes.mjs\n */\n\nexport type SlateCodeBlockPalette = {\n  mode: "light" | "dark";\n  background: string;\n  foreground: string;\n  border: string;\n  comment: string;\n  keyword: string;\n  string: string;\n  number: string;\n  definition: string;\n};\n\nexport const SLATE_CODE_BLOCK_PALETTES: Record<string, SlateCodeBlockPalette> = ${JSON.stringify(palettes, null, 2)};\n`;
fs.writeFileSync(outputPath, output);
console.log(`wrote ${outputPath}`);
