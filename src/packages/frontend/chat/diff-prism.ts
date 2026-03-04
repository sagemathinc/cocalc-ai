import { highlightCodeHtml } from "@cocalc/frontend/editors/slate/elements/code-block/prism";

export interface PrismLineMeta {
  raw: string;
  isCode: boolean;
  prefix: string;
  body: string;
}

export function isDiffContentLine(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return false;
  const prefix = line[0];
  return prefix === "+" || prefix === "-" || prefix === " ";
}

export function languageHintFromPath(path: string): string {
  const base = `${path ?? ""}`.trim().toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop() ?? "" : "";
  if (!ext) return "text";
  return ext;
}

export function escapeDiffHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildPrismLineMetasFromPatch(lines: string[]): PrismLineMeta[] {
  return lines.map((line) => {
    const isCode = isDiffContentLine(line);
    const prefix = isCode ? line[0] : "";
    const body = isCode ? line.slice(1) : line;
    return { raw: line, isCode, prefix, body };
  });
}

export function buildPrismLineMetasFromPlain(lines: string[]): PrismLineMeta[] {
  return lines.map((line) => ({
    raw: line,
    isCode: true,
    prefix: "",
    body: line,
  }));
}

function splitLinesPreserve(text: string): string[] {
  return text.split(/\n/);
}

export function highlightPrismLines(
  lineMetas: PrismLineMeta[],
  languageHint: string,
): string[] {
  const codeBodies = lineMetas.filter((x) => x.isCode).map((x) => x.body);
  const highlightedByCodeLine =
    codeBodies.length === 0
      ? []
      : splitLinesPreserve(highlightCodeHtml(codeBodies.join("\n"), languageHint));
  let codeIndex = 0;
  return lineMetas.map((meta) => {
    if (!meta.isCode) {
      return escapeDiffHtml(meta.raw);
    }
    const highlightedLine =
      highlightedByCodeLine[codeIndex++] ?? escapeDiffHtml(meta.body);
    return `${escapeDiffHtml(meta.prefix)}${highlightedLine}`;
  });
}

