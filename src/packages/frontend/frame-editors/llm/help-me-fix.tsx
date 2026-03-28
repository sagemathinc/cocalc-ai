/*
A generic button for helping a user fix problems using Codex.
If Codex is disabled or not available it renders as null.
*/

import { Alert, Space } from "antd";
import { CSSProperties, useState } from "react";

import { AIAvatar } from "@cocalc/frontend/components";
import { useCodexPaymentSource } from "@cocalc/frontend/chat/use-codex-payment-source";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptInWorkspaceChat,
} from "@cocalc/frontend/project/new/navigator-intents";
import type { ProjectsStore } from "@cocalc/frontend/projects/store";
import HelpMeFixButton from "./help-me-fix-button";
import {
  createMessage,
  createNavigatorIntentMessage,
} from "./help-me-fix-utils";

const DEFAULT_HELP_ME_FIX_AGENT_MODEL = "gpt-5.4-mini";

function getVisibleHelpPrompt(mode: "solution" | "hint"): string {
  return mode === "hint"
    ? "Diagnose this problem and give me a hint."
    : "Diagnose this problem and fix it.";
}

export { getHelp } from "./help-me-fix-utils";

interface Props {
  error: string | (() => string);
  line?: string | (() => string);
  input?: string | (() => string);
  task?: string;
  tag?: string;
  language?: string;
  extraFileInfo?: string;
  style?: CSSProperties;
  outerStyle?: CSSProperties;
  size?;
  prioritize?: "start" | "start-end" | "end";
}

function get(f: undefined | string | (() => string)): string {
  if (f == null) return "";
  if (typeof f === "string") return f;
  return f();
}

export default function HelpMeFix({
  error,
  line,
  task,
  input,
  tag,
  language,
  extraFileInfo,
  style,
  outerStyle,
  size,
  prioritize,
}: Props) {
  const { redux, project_id, path } = useFrameContext();
  const [gettingHelp, setGettingHelp] = useState<boolean>(false);
  const [errorGettingHelp, setErrorGettingHelp] = useState<string>("");
  const projectsStore: ProjectsStore = redux.getStore("projects");
  const canGetHintLegacy = projectsStore.hasLanguageModelEnabled(
    project_id,
    "help-me-fix-hint",
  );
  const canGetSolutionLegacy = projectsStore.hasLanguageModelEnabled(
    project_id,
    "help-me-fix-solution",
  );
  const needsCodexFallback = !canGetHintLegacy || !canGetSolutionLegacy;
  const { paymentSource } = useCodexPaymentSource({
    projectId: project_id,
    enabled: needsCodexFallback,
    pollMs: 90_000,
  });
  const codexAvailable =
    paymentSource?.source != null && paymentSource.source !== "none";
  const disableAIForAccount =
    !!redux.getStore("account").getIn(["customize", "disableAI"]) ||
    !!redux.getStore("account").getIn(["other_settings", "openai_disabled"]);
  const studentProjectSettings = projectsStore.getIn([
    "project_map",
    project_id,
    "course",
    "student_project_functionality",
  ]);
  const disableChatGPTInProject =
    !!studentProjectSettings?.get("disableChatGPT");
  const disableSomeChatGPTInProject =
    !!studentProjectSettings?.get("disableSomeChatGPT");

  const canGetHint =
    !disableAIForAccount &&
    !disableChatGPTInProject &&
    (canGetHintLegacy || codexAvailable);
  const canGetSolution =
    !disableAIForAccount &&
    !disableChatGPTInProject &&
    !disableSomeChatGPTInProject &&
    (canGetSolutionLegacy || codexAvailable);

  const shouldRender = redux != null && (canGetHint || canGetSolution);

  function createMessageMode(
    mode: "solution" | "hint",
    full: boolean = false,
  ): string {
    return createMessage({
      error: get(error),
      line: get(line),
      task,
      input: get(input),
      language,
      extraFileInfo,
      prioritize,
      open: true,
      full,
      isHint: mode === "hint",
    });
  }

  if (!shouldRender) {
    return null;
  }

  async function onConfirm(mode: "solution" | "hint") {
    setGettingHelp(true);
    setErrorGettingHelp("");
    try {
      const inputText = createMessageMode(mode, true);
      const tagSuffix = mode === "hint" ? "hint" : "solution";
      const sourceTag = `help-me-fix-${tagSuffix}${tag ? `:${tag}` : ""}`;
      const prompt = createNavigatorIntentMessage({
        message: inputText,
        project_id,
        path,
        isHint: mode === "hint",
        sourceTag,
      });
      const sent = await submitNavigatorPromptInWorkspaceChat({
        project_id,
        path,
        prompt,
        visiblePrompt: getVisibleHelpPrompt(mode),
        title: mode === "hint" ? "Get debugging hint" : "Fix problem",
        tag: `intent:error-fix:${tagSuffix}`,
        forceCodex: true,
        openFloating: true,
        codexConfig: { model: DEFAULT_HELP_ME_FIX_AGENT_MODEL },
      });
      if (!sent) {
        dispatchNavigatorPromptIntent({
          prompt,
          visiblePrompt: getVisibleHelpPrompt(mode),
          title: mode === "hint" ? "Get debugging hint" : "Fix problem",
          tag: `intent:error-fix:${tagSuffix}`,
          forceCodex: true,
          codexConfig: { model: DEFAULT_HELP_ME_FIX_AGENT_MODEL },
        });
      }
    } catch (err) {
      setErrorGettingHelp(`${err}`);
    } finally {
      setGettingHelp(false);
    }
  }

  return (
    <div style={outerStyle}>
      <Space>
        <AIAvatar size={16} />
        {canGetSolution && (
          <HelpMeFixButton
            mode="solution"
            inputText={createMessageMode("solution")}
            size={size}
            style={style}
            gettingHelp={gettingHelp}
            onConfirm={() => onConfirm("solution")}
          />
        )}
        {canGetHint && (
          <HelpMeFixButton
            mode="hint"
            inputText={createMessageMode("hint")}
            size={size}
            style={style}
            gettingHelp={gettingHelp}
            onConfirm={() => onConfirm("hint")}
          />
        )}
      </Space>
      {errorGettingHelp && (
        <Alert
          style={{ maxWidth: "600px", margin: "15px 0" }}
          type="error"
          showIcon
          closable
          title={errorGettingHelp}
          onClick={() => setErrorGettingHelp("")}
        />
      )}
    </div>
  );
}
