/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Launch a project Agent conversation for a rich-edit math widget. This follows
the help-me-fix navigator-intent pattern rather than opening an LLM popup or
modifying the CodeMirror buffer directly.
*/

import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptInWorkspaceChat,
} from "@cocalc/frontend/project/new/navigator-intents";

const MAX_CONTEXT_LINES = 2;
const MAX_CONTEXT_CHARS = 1000;
const DEFAULT_FORMULA_AGENT_MODEL = "gpt-5.4-mini";

interface Position {
  line: number;
  ch: number;
}

interface FormulaAgentOpts {
  project_id: string;
  path: string;
  source: string;
  from: Position;
  to: Position;
  context: string;
  contextTruncated: boolean;
}

function truncateInsideOut(
  before: string,
  source: string,
  after: string,
): { text: string; truncated: boolean } {
  const text = [before, source, after].filter(Boolean).join("\n");
  if (text.length <= MAX_CONTEXT_CHARS) {
    return { text, truncated: false };
  }

  // Keep the formula itself and then add the closest surrounding characters,
  // rather than taking an arbitrary prefix of a potentially enormous line.
  const sourceLimit =
    source.length > MAX_CONTEXT_CHARS
      ? MAX_CONTEXT_CHARS - 3 // two newlines and the ellipsis below
      : source.length;
  const shownSource =
    source.length <= sourceLimit
      ? source
      : source.slice(0, Math.floor(sourceLimit / 2)) +
        "\n…\n" +
        source.slice(-Math.ceil(sourceLimit / 2));
  // Reserve the separators used when all three pieces are present.
  const remaining = MAX_CONTEXT_CHARS - shownSource.length - 2;
  if (remaining <= 0) {
    return { text: shownSource, truncated: true };
  }
  const beforeLimit = Math.floor(remaining / 2);
  const afterLimit = remaining - beforeLimit;
  const tail = (text: string, limit: number) => {
    if (limit <= 0) return "";
    if (text.length <= limit) return text;
    return limit === 1 ? "…" : "…" + text.slice(-(limit - 1));
  };
  const head = (text: string, limit: number) => {
    if (limit <= 0) return "";
    if (text.length <= limit) return text;
    return limit === 1 ? "…" : text.slice(0, limit - 1) + "…";
  };
  return {
    text: [tail(before, beforeLimit), shownSource, head(after, afterLimit)]
      .filter(Boolean)
      .join("\n"),
    truncated: true,
  };
}

export function getFormulaAgentContext(
  getLine: (line: number) => string | undefined,
  lineCount: number,
  from: Position,
  to: Position,
  source: string,
): { text: string; truncated: boolean } {
  const before: string[] = [];
  for (
    let line = Math.max(0, from.line - MAX_CONTEXT_LINES);
    line < from.line;
    line++
  ) {
    before.push(getLine(line) ?? "");
  }
  const after: string[] = [];
  for (
    let line = to.line + 1;
    line <= Math.min(lineCount - 1, to.line + MAX_CONTEXT_LINES);
    line++
  ) {
    after.push(getLine(line) ?? "");
  }
  return truncateInsideOut(before.join("\n"), source, after.join("\n"));
}

export function createFormulaAgentPrompt({
  project_id,
  path,
  source,
  from,
  to,
  context,
  contextTruncated,
}: FormulaAgentOpts): string {
  const lineRange =
    from.line === to.line
      ? "line " + (from.line + 1)
      : "lines " + (from.line + 1) + "–" + (to.line + 1);
  return [
    "Handle this CoCalc LaTeX rich-editor formula-edit request as an agent.",
    "The user wants to revise the selected formula. Ask what change they want before editing anything.",
    "Treat the live in-memory sync document as authoritative. Do not assume the filesystem copy is current.",
    "When the user gives an instruction, inspect the live file, edit only the intended formula, preserve its existing LaTeX delimiters/style, and verify the result.",
    "The full project file path is " +
      path +
      "; the selected formula begins at " +
      lineRange +
      ".",
    "",
    "**Selected formula (exact LaTeX):**",
    "$$",
    source,
    "$$",
    "",
    "~~~tex",
    source,
    "~~~",
    "",
    "**Nearby source (" +
      MAX_CONTEXT_LINES +
      " lines each side; " +
      (contextTruncated ? "truncated to" : "at most") +
      " " +
      MAX_CONTEXT_CHARS +
      " characters):**",
    "~~~tex",
    context,
    "~~~",
    "",
    "<details><summary>Intent metadata</summary>",
    "~~~json",
    JSON.stringify(
      {
        source: "latex-rich-edit",
        intent: "intent:latex-formula-edit",
        project_id,
        path,
        line: from.line + 1,
        line_end: to.line + 1,
        ch: from.ch,
        ch_end: to.ch,
        context_truncated: contextTruncated,
      },
      null,
      2,
    ),
    "~~~",
    "</details>",
  ].join("\n");
}

export async function openFormulaAgent(opts: FormulaAgentOpts): Promise<void> {
  const prompt = createFormulaAgentPrompt(opts);
  const basename = opts.path.split("/").filter(Boolean).pop() ?? "LaTeX file";
  const title = "Edit formula in " + basename;
  const visiblePrompt = "Edit this LaTeX formula with Agent";
  const sent = await submitNavigatorPromptInWorkspaceChat({
    project_id: opts.project_id,
    path: opts.path,
    prompt,
    visiblePrompt,
    title,
    tag: "intent:latex-formula-edit",
    forceCodex: true,
    openFloating: true,
    waitForAgent: false,
    codexConfig: { model: DEFAULT_FORMULA_AGENT_MODEL },
  });
  if (!sent) {
    dispatchNavigatorPromptIntent({
      prompt,
      visiblePrompt,
      title,
      tag: "intent:latex-formula-edit",
      forceCodex: true,
      codexConfig: { model: DEFAULT_FORMULA_AGENT_MODEL },
    });
  }
}
