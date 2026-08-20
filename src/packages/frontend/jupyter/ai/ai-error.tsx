/*
Use the Agent to explain a notebook error and help fix it.
*/

import { Alert, Button, Modal, Space } from "antd";
import { useMemo, useState } from "react";

import { Tooltip } from "@cocalc/frontend/components";
import {
  AgentSessionError,
  AgentSessionSelect,
  usePersistentAgentSessionSelection,
} from "@cocalc/frontend/frame-editors/ai/agent-session-selector";
import {
  agentFileLocation,
  describeAgentFileLocation,
} from "@cocalc/frontend/frame-editors/ai/agent-file-context";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { submitNavigatorPromptInWorkspaceChat } from "@cocalc/frontend/project/new/navigator-intents";
import { kernelInfoField } from "../kernel-info-field";

const NOTEBOOK_FIX_VISIBLE_PROMPT =
  "Investigate and fix this Jupyter notebook error.";

interface Props {
  input: string;
  traceback: string;
  // id of the cell whose output contains the error
  cellId?: string;
  style?: React.CSSProperties;
}

function trimForPrompt(value: string, maxLen: number): string {
  const trimmed = `${value ?? ""}`.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}\n\n[truncated]`;
}

/*
The prompt behind the "fix this error" button on a notebook cell's output,
shared by the classic and Studio layouts (both render CellOutput).

It names `cocalc project jupyter` subcommands verbatim; those are defined in
@cocalc/cli/bin/commands/project/jupyter.ts, which carries a note pointing back
here.  Nothing checks this at build time.
*/
export function buildNotebookErrorPrompt(opts: {
  project_id?: string;
  path: string;
  cellId?: string;
  traceback: string;
  input: string;
  kernelLanguage?: string;
}): string {
  const traceback = trimForPrompt(opts.traceback, 12000);
  const input = trimForPrompt(opts.input, 12000);
  const location = agentFileLocation({
    project_id: opts.project_id,
    path: opts.path,
  });
  const cellId = `${opts.cellId ?? ""}`.trim();
  const parts = [
    "Investigate and fix this Jupyter notebook error.",
    `Notebook: ${describeAgentFileLocation(location)}`,
    cellId
      ? `The error is in the cell with id \`${cellId}\`. Use this id with \`cocalc project jupyter ...\` to read, edit, or run exactly that cell.`
      : undefined,
    "Treat the live in-memory notebook state as the source of truth, even if the file on disk is stale.",
    "Do not read or edit the `.ipynb` JSON directly for this task unless the user explicitly asks for filesystem-level work.",
    "Prefer `cocalc project jupyter ...` for notebook cell edits and execution because it remains available if the browser refreshes or disconnects.",
    "Use `cocalc project jupyter set`, `insert`, `move`, `delete`, `run`, or `exec` for live notebook changes.",
    "Use `cocalc browser exec` only for transient UI context such as the current selection, scroll position, or other browser-only state.",
    "Explain the root cause briefly, propose a fix, and apply changes when possible. Ask before installing or upgrading packages and before destructive actions.",
    "Traceback:",
    "```text",
    traceback,
    "```",
  ];
  if (input) {
    const lang = `${opts.kernelLanguage ?? ""}`.trim() || "python";
    parts.push("Cell input:", "```" + lang, input, "```");
  }
  return parts.filter(Boolean).join("\n\n");
}

export default function AIError({ traceback, input, cellId, style }: Props) {
  const { actions: frameActions, project_id, path } = useFrameContext();
  const [modalOpen, setModalOpen] = useState(false);
  const [routing, setRouting] = useState(false);
  const [routingError, setRoutingError] = useState("");
  const agentSessionSelection = usePersistentAgentSessionSelection({
    project_id,
    path,
    cacheContext: "jupyter-ai-error",
    enabled: frameActions != null,
  });

  const kernelInfo = (frameActions as any)?.jupyter_actions?.store?.get?.(
    "kernel_info",
  );
  const kernelLanguage = kernelInfoField(kernelInfo, "language", "python");

  const intentPrompt = useMemo(() => {
    return buildNotebookErrorPrompt({
      project_id,
      path,
      cellId,
      traceback,
      input,
      kernelLanguage,
    });
  }, [cellId, input, kernelLanguage, path, project_id, traceback]);

  if (frameActions == null) return null;

  async function routeToNavigator(): Promise<void> {
    setRouting(true);
    setRoutingError("");
    try {
      const sent = await submitNavigatorPromptInWorkspaceChat({
        project_id,
        path,
        prompt: intentPrompt,
        visiblePrompt: NOTEBOOK_FIX_VISIBLE_PROMPT,
        title: "Agent",
        tag: "intent:notebook-error",
        forceCodex: true,
        openFloating: true,
        waitForAgent: false,
        agentSession: agentSessionSelection.selectedAgentSession,
      });
      agentSessionSelection.saveSelectedAgentSession();
      if (!sent) {
        throw new Error("Unable to submit the notebook repair request.");
      }
      setModalOpen(false);
    } catch (err) {
      setRoutingError(`${err}`);
    } finally {
      setRouting(false);
    }
  }

  return (
    <div style={style}>
      <Tooltip title="Opens the workspace agent thread and submits this notebook error to the Agent.">
        <Button
          size="small"
          loading={routing}
          onClick={() => {
            setRoutingError("");
            setModalOpen(true);
          }}
        >
          Fix with Agent
        </Button>
      </Tooltip>
      <Modal
        title="Fix with Agent"
        open={modalOpen}
        onCancel={() => {
          if (!routing) {
            setModalOpen(false);
            setRoutingError("");
          }
        }}
        destroyOnHidden
        mask={{ closable: !routing }}
        footer={[
          <Button
            key="cancel"
            disabled={routing}
            onClick={() => {
              setModalOpen(false);
              setRoutingError("");
            }}
          >
            Cancel
          </Button>,
          <Button
            key="submit"
            type="primary"
            loading={routing}
            onClick={() => void routeToNavigator()}
          >
            Fix with Agent
          </Button>,
        ]}
      >
        <Space vertical size="middle" style={{ width: "100%" }}>
          <div>
            The selected agent session will receive the notebook path, the cell
            id, the traceback, and the cell input. The agent will use the live
            notebook state as the source of truth, investigate the failure, and
            apply a fix when it can do so safely.
          </div>
          <AgentSessionSelect
            selection={agentSessionSelection}
            disabled={routing}
          />
          <AgentSessionError selection={agentSessionSelection} />
          {routingError ? (
            <Alert type="error" showIcon title={routingError} />
          ) : null}
        </Space>
      </Modal>
    </div>
  );
}
