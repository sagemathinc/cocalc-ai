/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Modal, Space } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";

import { labels } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { submitNavigatorPromptInWorkspaceChat } from "@cocalc/frontend/project/new/navigator-intents";
import AIAvatar from "@cocalc/frontend/components/ai-avatar";
import { Icon } from "@cocalc/frontend/components/icon";
import { useFrameContext } from "@cocalc/frontend/app-framework";
import type { NotebookFrameActions } from "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/actions";
import { PopupAgentComposer } from "@cocalc/frontend/frame-editors/llm/popup-agent-composer";
import track from "@cocalc/frontend/user-tracking";
import type { JupyterActions } from "../browser-actions";
import type { Position } from "./types";

interface AIGenerateCodeCellProps {
  actions: JupyterActions;
  children: React.ReactNode;
  frameActions: React.MutableRefObject<NotebookFrameActions | undefined>;
  id: string;
  setShowAICellGen: (show: Position) => void;
  showAICellGen: Position;
}

const DEFAULT_GENERATE_AGENT_MODEL = "gpt-5.4-mini";

function normalizeCellType(value: string | undefined): "code" | "markdown" {
  return value === "markdown" ? "markdown" : "code";
}

function cellLabel(cellType: "code" | "markdown"): string {
  return cellType === "markdown" ? "Markdown cell" : "code cell";
}

function describePlacement(
  position: Exclude<Position, null>,
  anchorCellType: "code" | "markdown",
): string {
  const label = cellLabel(anchorCellType);
  switch (position) {
    case "above":
      return `above this ${label}`;
    case "below":
      return `below this ${label}`;
    case "replace":
      return `by replacing this ${label}`;
  }
}

export function buildGenerateCellVisiblePrompt(opts: {
  prompt: string;
  position: Exclude<Position, null>;
  anchorCellType: "code" | "markdown";
}): string {
  const request = opts.prompt.trim();
  const placement = describePlacement(opts.position, opts.anchorCellType);
  return `Generate new cells ${placement}: ${request}`;
}

export function buildGenerateCellHiddenPrompt(opts: {
  prompt: string;
  path: string;
  cellId: string;
  anchorCellType: "code" | "markdown";
  position: Exclude<Position, null>;
  kernelLanguage: string;
  kernelDisplay: string;
}): string {
  const placement = describePlacement(opts.position, opts.anchorCellType);
  const parts = [
    `Generate one or more notebook cells ${placement} according to this request: ${opts.prompt.trim()}`,
    `Jupyter notebook path: ${opts.path}`,
    `Anchor cell id: ${opts.cellId}`,
    `Anchor cell type: ${opts.anchorCellType}`,
    `Requested position: ${opts.position}`,
    `Kernel language: ${opts.kernelLanguage}`,
    `Kernel display name: ${opts.kernelDisplay}`,
    "Treat the live in-memory notebook state as the source of truth, even if the file on disk is stale.",
    "Prefer `cocalc project jupyter ...` for notebook cell edits and execution because it remains available if the browser refreshes or disconnects.",
    "Use `cocalc browser exec` only for transient UI context such as the current selection, scroll position, or other browser-only state.",
    "Start from the anchor cell. Inspect surrounding cells, outputs, notebook execution state, or files on disk only if needed.",
    "Decide whether the result should be code cells, Markdown cells, or both. Insert or replace cells in the requested location when appropriate.",
    "Ask before destructive actions or installing or upgrading packages.",
  ];
  return parts.join("\n\n");
}

export function AIGenerateCodeCell({
  actions,
  children,
  frameActions,
  id,
  setShowAICellGen,
  showAICellGen,
}: AIGenerateCodeCellProps) {
  const intl = useIntl();
  const { actions: projectActions } = useProjectContext();
  const { project_id, path } = useFrameContext();
  const [prompt, setPrompt] = useState("");
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState("");

  const open = showAICellGen != null;
  const anchorCellType = useMemo(
    () =>
      normalizeCellType(
        frameActions.current?.get_cell_by_id(id)?.get?.("cell_type", "code"),
      ),
    [frameActions, id],
  );
  const kernelInfo = actions.store.get("kernel_info");
  const kernelLanguage = kernelInfo?.get("language") ?? "python";
  const kernelDisplay = kernelInfo?.get("display_name") ?? "Python 3";
  const placement =
    showAICellGen == null
      ? ""
      : describePlacement(showAICellGen, anchorCellType);
  const canSubmit =
    prompt.trim().length > 0 && !querying && showAICellGen != null;

  useEffect(() => {
    if (!open) {
      setPrompt("");
      setQuerying(false);
      setError("");
      return;
    }
    setError("");
  }, [open]);

  async function submit(nextPrompt?: string): Promise<void> {
    const effectivePrompt = `${nextPrompt ?? prompt}`.trim();
    if (showAICellGen == null || !effectivePrompt || querying) return;
    setQuerying(true);
    setError("");
    try {
      const visiblePrompt = buildGenerateCellVisiblePrompt({
        prompt: effectivePrompt,
        position: showAICellGen,
        anchorCellType,
      });
      const hiddenPrompt = buildGenerateCellHiddenPrompt({
        prompt: effectivePrompt,
        path,
        cellId: id,
        anchorCellType,
        position: showAICellGen,
        kernelLanguage,
        kernelDisplay,
      });
      const sent = await submitNavigatorPromptInWorkspaceChat({
        project_id,
        path,
        prompt: hiddenPrompt,
        visiblePrompt,
        title: "Agent",
        tag: `intent:jupyter-generate-cell:${showAICellGen}`,
        forceCodex: true,
        codexConfig: { model: DEFAULT_GENERATE_AGENT_MODEL },
        openFloating: true,
      });
      if (!sent) {
        throw new Error(
          "Unable to send this cell generation request to the Agent.",
        );
      }
      projectActions?.log({
        event: "llm",
        usage: "jupyter-generate-cell",
        model: DEFAULT_GENERATE_AGENT_MODEL,
        path,
      });
      track("chatgpt", {
        project_id,
        path,
        tag: "generate-jupyter-cell",
        type: "generate",
        model: DEFAULT_GENERATE_AGENT_MODEL,
        position: showAICellGen,
      });
      setShowAICellGen(null);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setQuerying(false);
    }
  }

  return (
    <>
      {children}
      <Modal
        destroyOnClose
        title={
          <Space size="small">
            <AIAvatar size={18} />
            <span>Generate with Agent</span>
          </Space>
        }
        open={open}
        onCancel={() => setShowAICellGen(null)}
        footer={null}
        width={560}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <div style={{ color: "rgba(0,0,0,0.65)" }}>
            Agent will inspect the live notebook state itself. The frontend is
            only sending the notebook path, the anchor cell id, the requested
            placement, and your request.
          </div>
          <div style={{ color: "rgba(0,0,0,0.65)" }}>
            Target: generate new cells {placement}.
          </div>
          <PopupAgentComposer
            value={prompt}
            onChange={setPrompt}
            onSubmit={(value) => void submit(value)}
            placeholder="Describe the cells you want Agent to generate..."
            cacheId={`popup-agent:jupyter-generate:${path}:${id}:${showAICellGen ?? "none"}`}
            autoFocus
          />
          {error ? <Alert type="error" title={error} /> : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setShowAICellGen(null)} disabled={querying}>
              {intl.formatMessage(labels.cancel)}
            </Button>
            <Button
              type="primary"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              <Icon
                name={querying ? "spinner" : "paper-plane"}
                spin={querying}
              />{" "}
              Send to Agent
            </Button>
          </div>
        </Space>
      </Modal>
    </>
  );
}
