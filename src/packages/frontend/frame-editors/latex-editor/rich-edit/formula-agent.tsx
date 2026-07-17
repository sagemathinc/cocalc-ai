/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Launch a project Agent conversation for a rich-edit math widget. This follows
the help-me-fix navigator-intent pattern rather than opening an LLM popup or
modifying the CodeMirror buffer directly.
*/

import { Button, Input, Modal, Space, Typography } from "antd";
import { useState } from "react";

import { show_react_modal } from "@cocalc/frontend/misc";
import mathToHtml from "@cocalc/frontend/misc/math-to-html";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptInWorkspaceChat,
} from "@cocalc/frontend/project/new/navigator-intents";
import { COLORS } from "@cocalc/util/theme";

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
  formulaType: "math-inline" | "math-display" | "math-env";
  formulaContent?: string;
  macros?: Record<string, string>;
  instruction?: string;
}

function formulaMarkdown(opts: FormulaAgentOpts): string {
  if (opts.formulaType === "math-env") {
    return opts.source;
  }
  const content = opts.formulaContent ?? opts.source;
  return ["$$", content, "$$"].join("\n");
}

export function createFormulaAgentPrompt(opts: FormulaAgentOpts): string {
  const { project_id, path, source, from, to, instruction } = opts;
  return [
    "**Edit this LaTeX formula:**",
    formulaMarkdown(opts),
    "",
    "**Requested change:**",
    instruction ?? "",
    "",
    "<details><summary>Agent instructions and context</summary>",
    "",
    "Handle this CoCalc LaTeX rich-editor formula-edit request as an agent.",
    "The user has already described the requested formula change below. Do not ask them to repeat it.",
    "Treat the live in-memory sync document as authoritative. Do not assume the filesystem copy is current.",
    "Perform the requested edit now: open the exact file and edit only the intended formula. Do not merely reply with proposed LaTeX or describe an edit.",
    "Preserve the formula's existing LaTeX delimiters/style, verify the saved live-document result, then briefly report what changed.",
    "If you cannot access or edit the live document, state that specific blocker instead of claiming the formula was changed.",
    "",
    "**Selected formula (raw TeX):**",
    "~~~tex",
    source,
    "~~~",
    "",
    "**Intent metadata:**",
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
      },
      null,
      2,
    ),
    "~~~",
    "</details>",
  ].join("\n");
}

function FormulaPreview({ opts }: { opts: FormulaAgentOpts }) {
  const isInline = opts.formulaType === "math-inline";
  let math = opts.formulaContent ?? opts.source;
  if (opts.formulaType === "math-env") {
    math = math.replace(
      /\\(begin|end)\{(equation|align|gather|multline)\}/g,
      "\\$1{$2*}",
    );
  }
  const { __html, err } = mathToHtml(math, isInline, opts.macros);
  return (
    <div
      style={{
        maxHeight: 160,
        overflow: "auto",
        padding: "8px 12px",
        border: "1px solid " + COLORS.GRAY_LL,
        borderRadius: 4,
        background: COLORS.GRAY_LLL,
        textAlign: isInline ? "left" : "center",
      }}
    >
      {err ? (
        <Typography.Text code>{opts.source}</Typography.Text>
      ) : (
        <span dangerouslySetInnerHTML={{ __html }} />
      )}
    </div>
  );
}

function FormulaEditDialog({
  opts,
  close,
}: {
  opts: FormulaAgentOpts;
  close: (err?: any, result?: string) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const trimmed = instruction.trim();
  return (
    <Modal
      title="Edit formula with Agent"
      open
      width={560}
      onCancel={() => close()}
      footer={
        <Space>
          <Button onClick={() => close()}>Cancel</Button>
          <Button
            type="primary"
            disabled={!trimmed}
            onClick={() => close(undefined, trimmed)}
          >
            Edit with Agent
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <FormulaPreview opts={opts} />
        <Input.TextArea
          autoFocus
          rows={3}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey || !trimmed) return;
            event.preventDefault();
            close(undefined, trimmed);
          }}
          placeholder="Describe the change you want to make to this formula..."
        />
      </Space>
    </Modal>
  );
}

async function getFormulaEditInstruction(
  opts: FormulaAgentOpts,
): Promise<string | undefined> {
  return await show_react_modal((close) => (
    <FormulaEditDialog opts={opts} close={close} />
  ));
}

export async function openFormulaAgent(opts: FormulaAgentOpts): Promise<void> {
  const instruction = await getFormulaEditInstruction(opts);
  if (!instruction) return;
  const request = { ...opts, instruction };
  const prompt = createFormulaAgentPrompt(request);
  const basename = opts.path.split("/").filter(Boolean).pop() ?? "LaTeX file";
  const title = "Edit formula in " + basename;
  const sent = await submitNavigatorPromptInWorkspaceChat({
    project_id: opts.project_id,
    path: opts.path,
    prompt,
    visiblePrompt: prompt,
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
      visiblePrompt: prompt,
      title,
      tag: "intent:latex-formula-edit",
      forceCodex: true,
      codexConfig: { model: DEFAULT_FORMULA_AGENT_MODEL },
    });
  }
}
