/*
Use ChatGPT to explain an error message and help the user fix it.
*/

import { Alert, Button, Space, Typography } from "antd";
import { CSSProperties, useMemo, useState } from "react";

import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import HelpMeFix from "@cocalc/frontend/frame-editors/llm/help-me-fix";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptToCurrentThread,
} from "@cocalc/frontend/project/new/navigator-intents";

const DEFAULT_FIX_WITH_AGENT_MODEL = "gpt-5.4-mini";

interface Props {
  style?: CSSProperties;
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

export default function LLMError({ style, traceback, input }: Props) {
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
      const sent = await submitNavigatorPromptToCurrentThread({
        project_id,
        path,
        prompt: intentPrompt,
        tag: "intent:notebook-error",
        forceCodex: true,
        openFloating: true,
        codexConfig: { model: DEFAULT_FIX_WITH_AGENT_MODEL },
      });
      if (!sent) {
        dispatchNavigatorPromptIntent({
          prompt: intentPrompt,
          tag: "intent:notebook-error",
          forceCodex: true,
          codexConfig: { model: DEFAULT_FIX_WITH_AGENT_MODEL },
        });
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
        <Button
          size="small"
          loading={routing}
          onClick={() => void routeToNavigator()}
        >
          Fix with Agent
        </Button>
        <Typography.Text type="secondary">
          Sends this notebook error to the Navigator Codex session.
        </Typography.Text>
      </Space>
      <HelpMeFix
        style={style}
        task="ran a cell in a Jupyter notebook"
        error={traceback}
        input={input}
        tag="jupyter-notebook-cell-eval"
        extraFileInfo={frameActions.languageModelExtraFileInfo()}
        language={frameActions.languageModelGetLanguage()}
      />
      {routingError ? (
        <Alert
          style={{ marginTop: 8, maxWidth: 720 }}
          type="error"
          showIcon
          message={routingError}
        />
      ) : null}
    </div>
  );
}
