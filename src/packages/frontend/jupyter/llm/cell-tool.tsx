/*
Use the Agent to work on a Jupyter cell.
*/

import { Alert, Button, Dropdown, Input, Modal, Space, Tooltip } from "antd";
import { useEffect, useMemo, useState } from "react";
import { defineMessage, useIntl } from "react-intl";
import type { Entries } from "type-fest";

import { useProjectContext } from "@cocalc/frontend/project/context";
import { submitNavigatorPromptInWorkspaceChat } from "@cocalc/frontend/project/new/navigator-intents";
import AIAvatar from "@cocalc/frontend/components/ai-avatar";
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { labels, type IntlMessage } from "@cocalc/frontend/i18n";
import track from "@cocalc/frontend/user-tracking";
import type { LLMTools } from "@cocalc/jupyter/types";
import type { JupyterActions } from "../browser-actions";
import { CODE_BAR_BTN_STYLE } from "../consts";

interface Props {
  actions?: JupyterActions;
  id: string;
  style?: React.CSSProperties;
  llmTools?: LLMTools;
  cellType: "code" | "markdown";
}

const TRACKING_KEY = "jupyter_cell_llm";
const DEFAULT_CELL_TOOL_CODEX_MODEL = "gpt-5.4-mini";

const MODES_CODE = [
  "ask",
  "explain",
  "bugfix",
  "modify",
  "improve",
  "document",
  "translate",
] as const;

const MODES_MD = [
  "ask",
  "document",
  "proofread",
  "formulize",
  "translate_text",
] as const;

export type CodeMode = (typeof MODES_CODE)[number];
export type MarkdownMode = (typeof MODES_MD)[number];
export type Mode = CodeMode | MarkdownMode;

interface CodexCellToolAction {
  icon: IconName;
  label: IntlMessage;
  descr: IntlMessage;
}

const ACTIONS_CODE: { [mode in CodeMode]: CodexCellToolAction } = {
  ask: {
    icon: "question-circle",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.ask.label",
      defaultMessage: "Ask",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.ask.descr",
      defaultMessage: "Ask the Agent a question about this cell.",
    }),
  },
  explain: {
    icon: "sound-outlined",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.explain.label",
      defaultMessage: "Explain",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.explain.descr",
      defaultMessage: "Ask the Agent to explain what this cell is doing.",
    }),
  },
  bugfix: {
    icon: "clean-outlined",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.bugfix.label",
      defaultMessage: "Fix Bugs",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.bugfix.descr",
      defaultMessage:
        "Ask the Agent to diagnose and fix problems in this cell.",
    }),
  },
  modify: {
    icon: "edit",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.modify.label",
      defaultMessage: "Modify",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.modify.descr",
      defaultMessage: "Ask the Agent to make a specific change to this cell.",
    }),
  },
  improve: {
    icon: "rise-outlined",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.improve.label",
      defaultMessage: "Improve",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.improve.descr",
      defaultMessage: "Ask the Agent to improve this cell.",
    }),
  },
  document: {
    icon: "book",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.document.label",
      defaultMessage: "Document",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.document.descr",
      defaultMessage: "Ask the Agent to document this cell.",
    }),
  },
  translate: {
    icon: "translation-outlined",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.translate.label",
      defaultMessage: "Translate",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.translate.descr",
      defaultMessage:
        "Ask the Agent to translate this cell to another language.",
    }),
  },
};

const ACTIONS_MD: { [mode in MarkdownMode]: CodexCellToolAction } = {
  ask: {
    icon: "question-circle",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.ask.label",
      defaultMessage: "Ask",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.md.ask.descr",
      defaultMessage: "Ask the Agent a question about this Markdown cell.",
    }),
  },
  document: {
    icon: "book",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.md.document.label",
      defaultMessage: "Document",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.md.document.descr",
      defaultMessage:
        "Ask the Agent to improve the documentation in this cell.",
    }),
  },
  proofread: {
    icon: "check-circle",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.md.proofread.label",
      defaultMessage: "Proofread",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.md.proofread.descr",
      defaultMessage: "Ask the Agent to proofread this Markdown cell.",
    }),
  },
  formulize: {
    icon: "fx",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.md.formulize.label",
      defaultMessage: "Add Formulas",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.md.formulize.descr",
      defaultMessage:
        "Ask the Agent to add useful formulas to this Markdown cell.",
    }),
  },
  translate_text: {
    icon: "global",
    label: defineMessage({
      id: "jupyter.llm.cell-tool.actions.md.translate-text.label",
      defaultMessage: "Translate",
    }),
    descr: defineMessage({
      id: "jupyter.llm.cell-tool.actions.md.translate-text.descr",
      defaultMessage: "Ask the Agent to translate this Markdown cell.",
    }),
  },
};

function actionLabel(mode: Mode, isMarkdownCell: boolean): IntlMessage {
  return isMarkdownCell
    ? ACTIONS_MD[mode as MarkdownMode].label
    : ACTIONS_CODE[mode as CodeMode].label;
}

function actionDescription(mode: Mode, isMarkdownCell: boolean): IntlMessage {
  return isMarkdownCell
    ? ACTIONS_MD[mode as MarkdownMode].descr
    : ACTIONS_CODE[mode as CodeMode].descr;
}

function defaultTargetLanguage(isMarkdownCell: boolean): string {
  return isMarkdownCell ? "Spanish" : "R";
}

function requiresFreeformInput(mode: Mode): boolean {
  return mode === "ask" || mode === "modify";
}

function optionalPromptLabel(
  mode: Mode,
  intl: ReturnType<typeof useIntl>,
): string {
  switch (mode) {
    case "ask":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.prompt.ask",
        defaultMessage: "Question",
      });
    case "bugfix":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.prompt.bugfix",
        defaultMessage: "Problem details",
      });
    case "modify":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.prompt.modify",
        defaultMessage: "Requested change",
      });
    case "improve":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.prompt.improve",
        defaultMessage: "Improvement focus",
      });
    case "document":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.prompt.document",
        defaultMessage: "Documentation focus",
      });
    case "translate":
    case "translate_text":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.prompt.translate",
        defaultMessage: "Target language",
      });
    case "explain":
    case "proofread":
    case "formulize":
      return "";
  }
}

function optionalPromptPlaceholder(
  mode: Mode,
  cellType: "code" | "markdown",
  intl: ReturnType<typeof useIntl>,
): string {
  switch (mode) {
    case "ask":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.ask.placeholder",
        defaultMessage: `What would you like to know about this ${cellType === "code" ? "cell" : "Markdown cell"}?`,
      });
    case "bugfix":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.bugfix.placeholder",
        defaultMessage:
          "Optional: describe the issue you want the Agent to focus on.",
      });
    case "modify":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.modify.placeholder",
        defaultMessage: "Describe the change you want the Agent to make.",
      });
    case "improve":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.improve.placeholder",
        defaultMessage:
          "Optional: performance, readability, structure, tests, …",
      });
    case "document":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.document.placeholder",
        defaultMessage: "Optional: what should the documentation focus on?",
      });
    case "translate":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.translate.placeholder",
        defaultMessage: "R, Julia, JavaScript, LaTeX, …",
      });
    case "translate_text":
      return intl.formatMessage({
        id: "jupyter.llm.cell-tool.translate-text.placeholder",
        defaultMessage: "Spanish, French, German, …",
      });
    case "explain":
    case "proofread":
    case "formulize":
      return "";
  }
}

export function buildVisiblePrompt(opts: {
  mode: Mode;
  cellType: "code" | "markdown";
  extra: string;
  targetLanguage: string;
}): string {
  const cellLabel = opts.cellType === "code" ? "cell" : "Markdown cell";
  switch (opts.mode) {
    case "ask":
      return opts.extra.trim();
    case "explain":
      return `Explain this ${cellLabel}.`;
    case "bugfix":
      return opts.extra.trim()
        ? `Fix this ${cellLabel}: ${opts.extra.trim()}`
        : `Find and fix problems in this ${cellLabel}.`;
    case "modify":
      return `Modify this ${cellLabel}: ${opts.extra.trim()}`;
    case "improve":
      return opts.extra.trim()
        ? `Improve this ${cellLabel}: ${opts.extra.trim()}`
        : `Improve this ${cellLabel}.`;
    case "document":
      return opts.extra.trim()
        ? `Document this ${cellLabel}: ${opts.extra.trim()}`
        : `Document this ${cellLabel}.`;
    case "translate":
    case "translate_text":
      return `Translate this ${cellLabel} to ${opts.targetLanguage.trim()}.`;
    case "proofread":
      return `Proofread this Markdown cell.`;
    case "formulize":
      return `Add formulas to this Markdown cell.`;
  }
}

export function buildHiddenPrompt(opts: {
  mode: Mode;
  path: string;
  cellId: string;
  cellType: "code" | "markdown";
  kernelLanguage: string;
  kernelDisplay: string;
  extra: string;
  targetLanguage: string;
}): string {
  const parts = [
    `Jupyter notebook path: ${opts.path}`,
    `Selected cell id: ${opts.cellId}`,
    `Selected cell type: ${opts.cellType}`,
    `Kernel language: ${opts.kernelLanguage}`,
    `Kernel display name: ${opts.kernelDisplay}`,
    "Treat the live in-memory notebook state as the source of truth, even if the file on disk is stale.",
    "Start with the selected cell. Inspect surrounding cells, outputs, notebook execution state, or files on disk only if needed.",
    "If you decide changes are appropriate, apply them when possible. Ask before destructive actions or installing or upgrading packages.",
  ];

  switch (opts.mode) {
    case "ask":
      parts.unshift(
        `Answer this question about the selected notebook cell: ${opts.extra.trim()}`,
      );
      break;
    case "explain":
      parts.unshift("Explain the selected notebook cell.");
      break;
    case "bugfix":
      parts.unshift(
        opts.extra.trim()
          ? `Diagnose and fix the selected notebook cell. Focus on this issue if relevant: ${opts.extra.trim()}`
          : "Diagnose and fix the selected notebook cell.",
      );
      break;
    case "modify":
      parts.unshift(
        `Modify the selected notebook cell according to this request: ${opts.extra.trim()}`,
      );
      break;
    case "improve":
      parts.unshift(
        opts.extra.trim()
          ? `Improve the selected notebook cell. Focus on this improvement goal: ${opts.extra.trim()}`
          : "Improve the selected notebook cell.",
      );
      break;
    case "document":
      parts.unshift(
        opts.extra.trim()
          ? `Document the selected notebook cell. Focus on: ${opts.extra.trim()}`
          : "Document the selected notebook cell.",
      );
      break;
    case "translate":
      parts.unshift(
        `Translate the selected notebook cell to ${opts.targetLanguage.trim()}.`,
      );
      break;
    case "translate_text":
      parts.unshift(
        `Translate the selected Markdown cell to ${opts.targetLanguage.trim()}.`,
      );
      break;
    case "proofread":
      parts.unshift("Proofread the selected Markdown cell.");
      break;
    case "formulize":
      parts.unshift(
        "Add useful mathematical formulas to the selected Markdown cell.",
      );
      break;
  }

  return parts.join("\n\n");
}

export function stopKeyboardPropagation(
  e: React.KeyboardEvent<HTMLElement>,
): void {
  e.stopPropagation();
}

export function LLMCellTool({ actions, id, style, llmTools, cellType }: Props) {
  const intl = useIntl();
  const { actions: projectActions } = useProjectContext();
  const { project_id, path } = useFrameContext();
  const [mode, setMode] = useState<Mode | null>(null);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState("");
  const [extraPrompt, setExtraPrompt] = useState("");
  const [targetLanguage, setTargetLanguage] = useState<string>(
    defaultTargetLanguage(cellType === "markdown"),
  );

  const isMarkdownCell = cellType === "markdown";

  const kernelInfo = actions?.store.get("kernel_info");
  const kernelLanguage = kernelInfo?.get("language") ?? "python";
  const kernelDisplay = kernelInfo?.get("display_name") ?? "Python 3";

  useEffect(() => {
    if (mode == null) return;
    setError("");
    if (mode === "translate" || mode === "translate_text") {
      setTargetLanguage(defaultTargetLanguage(isMarkdownCell));
    } else {
      setTargetLanguage("");
    }
    setExtraPrompt("");
  }, [mode, isMarkdownCell]);

  const canSubmit = useMemo(() => {
    if (mode == null || querying) return false;
    if (requiresFreeformInput(mode)) {
      return extraPrompt.trim().length > 0;
    }
    if (mode === "translate" || mode === "translate_text") {
      return targetLanguage.trim().length > 0;
    }
    return true;
  }, [extraPrompt, mode, querying, targetLanguage]);

  if (actions == null || llmTools == null) {
    return null;
  }

  const actionMap = isMarkdownCell ? ACTIONS_MD : ACTIONS_CODE;

  async function submit(): Promise<void> {
    if (mode == null || !canSubmit) return;
    setQuerying(true);
    setError("");
    try {
      const visiblePrompt = buildVisiblePrompt({
        mode,
        cellType,
        extra: extraPrompt,
        targetLanguage,
      });
      const prompt = buildHiddenPrompt({
        mode,
        path,
        cellId: id,
        cellType,
        kernelLanguage,
        kernelDisplay,
        extra: extraPrompt,
        targetLanguage,
      });
      const title = `${intl.formatMessage(actionLabel(mode, isMarkdownCell))} cell`;
      const sent = await submitNavigatorPromptInWorkspaceChat({
        project_id,
        path,
        prompt,
        visiblePrompt,
        title,
        tag: `intent:jupyter-cell:${mode}`,
        forceCodex: true,
        codexConfig: { model: DEFAULT_CELL_TOOL_CODEX_MODEL },
        openFloating: true,
      });
      if (!sent) {
        throw new Error("Unable to send this cell request to the Agent.");
      }
      projectActions?.log({
        event: "llm",
        usage: "jupyter-cell-button",
        model: DEFAULT_CELL_TOOL_CODEX_MODEL,
        mode,
        path,
      });
      track(TRACKING_KEY, {
        action: "submitted",
        mode,
        path,
        model: DEFAULT_CELL_TOOL_CODEX_MODEL,
        project_id,
      });
      setMode(null);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setQuerying(false);
    }
  }

  function renderComposer() {
    if (mode == null) return null;
    const label = optionalPromptLabel(mode, intl);
    const placeholder = optionalPromptPlaceholder(mode, cellType, intl);
    const needsText =
      requiresFreeformInput(mode) ||
      mode === "bugfix" ||
      mode === "improve" ||
      mode === "document";
    const needsTarget = mode === "translate" || mode === "translate_text";

    return (
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <div style={{ color: "rgba(0,0,0,0.65)" }}>
          {intl.formatMessage(actionDescription(mode, isMarkdownCell))}
        </div>
        {needsText ? (
          <div>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>{label}</div>
            <Input.TextArea
              value={extraPrompt}
              onChange={(e) => setExtraPrompt(e.target.value)}
              onKeyDown={stopKeyboardPropagation}
              rows={3}
              placeholder={placeholder}
              autoFocus
            />
          </div>
        ) : null}
        {needsTarget ? (
          <div>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>{label}</div>
            <Input
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              onKeyDown={stopKeyboardPropagation}
              placeholder={placeholder}
              autoFocus
            />
          </div>
        ) : null}
        <div style={{ color: "rgba(0,0,0,0.65)" }}>
          The Agent will inspect the live notebook state itself. The frontend is
          only sending the notebook path, the selected cell id, and your
          request.
        </div>
      </Space>
    );
  }

  return (
    <div style={style}>
      <Modal
        destroyOnClose
        title={
          mode == null ? null : (
            <Space size="small">
              <AIAvatar size={18} />
              <span>
                {intl.formatMessage(actionLabel(mode, isMarkdownCell))} with
                Agent
              </span>
            </Space>
          )
        }
        open={mode != null}
        onCancel={() => {
          setMode(null);
          setError("");
          setQuerying(false);
        }}
        footer={null}
      >
        {renderComposer()}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
          <Button
            onClick={() => {
              setMode(null);
              setError("");
              setQuerying(false);
            }}
            disabled={querying}
          >
            {intl.formatMessage(labels.cancel)}
          </Button>
          <Button
            type="primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            <Icon name={querying ? "spinner" : "paper-plane"} spin={querying} />{" "}
            Send to Agent
          </Button>
        </div>
      </Modal>

      <Dropdown
        trigger={["click"]}
        mouseLeaveDelay={1.5}
        menu={{
          items: (Object.entries(actionMap) as Entries<typeof actionMap>).map(
            ([entryMode, action]) => ({
              key: entryMode,
              label: (
                <Tooltip
                  title={intl.formatMessage(action.descr)}
                  placement="left"
                >
                  <Icon name={action.icon} style={{ marginRight: "5px" }} />
                  {intl.formatMessage(action.label)}…
                </Tooltip>
              ),
              onClick: () => setMode(entryMode as Mode),
            }),
          ),
        }}
      >
        <Tooltip
          title={intl.formatMessage({
            id: "jupyter.llm.cell-tool.assistant.title",
            defaultMessage: "Use Agent on this cell",
          })}
        >
          <Button
            disabled={querying}
            type="text"
            size="small"
            style={CODE_BAR_BTN_STYLE}
            icon={<AIAvatar size={14} style={{ top: "1px" }} />}
          >
            <Space size="small">
              Agent
              <Icon name="angle-down" />
            </Space>
          </Button>
        </Tooltip>
      </Dropdown>

      {error ? (
        <Alert
          style={{ maxWidth: "600px", fontSize: "10px", margin: "0" }}
          type="error"
          banner
          showIcon
          closable
          title={error}
          onClick={() => setError("")}
        />
      ) : undefined}
    </div>
  );
}
