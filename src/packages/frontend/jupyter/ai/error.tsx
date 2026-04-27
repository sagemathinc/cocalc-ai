/*
Use ChatGPT to explain an error message and help the user fix it.
*/

import { Alert, Button, Space } from "antd";
import { useMemo, useState } from "react";

import { Tooltip } from "@cocalc/frontend/components";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { submitNavigatorPromptInWorkspaceChat } from "@cocalc/frontend/project/new/navigator-intents";

const DEFAULT_FIX_WITH_AGENT_MODEL = "gpt-5.4-mini";
const NOTEBOOK_FIX_VISIBLE_PROMPT =
  "Investigate and fix this Jupyter notebook error.";

interface Props {
  input: string;
  traceback: string;
}

function trimForPrompt(value: string, maxLen: number): string {
  const trimmed = `${value ?? ""}`.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}\n\n[truncated]`;
}

function buildNotebookErrorPrompt(opts: {
  path: string;
  traceback: string;
  input: string;
}): string {
  const traceback = trimForPrompt(opts.traceback, 12000);
  const input = trimForPrompt(opts.input, 12000);
  const parts = [
    "Investigate and fix this Jupyter notebook error.",
    `Notebook path: ${opts.path}`,
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
    parts.push("Cell input:", "```python", input, "```");
  }
  return parts.join("\n\n");
}

export default function LLMError({ traceback, input }: Props) {
  const { actions: frameActions, project_id, path } = useFrameContext();
  const [routing, setRouting] = useState(false);
  const [routingError, setRoutingError] = useState("");

  const intentPrompt = useMemo(() => {
    return buildNotebookErrorPrompt({ path, traceback, input });
  }, [input, path, traceback]);

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
        codexConfig: { model: DEFAULT_FIX_WITH_AGENT_MODEL },
        openFloating: true,
        waitForAgent: false,
      });
      if (!sent) {
        throw new Error("Unable to submit the notebook repair request.");
      }
    } catch (err) {
      setRoutingError(`${err}`);
    } finally {
      setRouting(false);
    }
  }

  return (
    <div>
      <Space wrap size={[8, 8]} style={{ marginBottom: 8 }}>
        <Tooltip title="Opens the workspace agent thread and submits this notebook error to the Agent.">
          <Button
            size="small"
            loading={routing}
            onClick={() => void routeToNavigator()}
          >
            Fix with Agent
          </Button>
        </Tooltip>
      </Space>
      {routingError ? (
        <Alert
          style={{ marginTop: 8, maxWidth: 720 }}
          type="error"
          showIcon
          title={routingError}
        />
      ) : null}
    </div>
  );
}
