/*
A generic button for helping a user fix problems using chatgpt.
If chatgpt is disabled or not available it renders as null.
*/

import { Alert, Space } from "antd";
import { CSSProperties, useState } from "react";
import useAsyncEffect from "use-async-effect";

import { useLanguageModelSetting } from "@cocalc/frontend/account/useLanguageModelSetting";
import { AIAvatar } from "@cocalc/frontend/components";
import { useCodexPaymentSource } from "@cocalc/frontend/chat/use-codex-payment-source";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { dispatchNavigatorPromptIntent } from "@cocalc/frontend/project/new/navigator-intents";
import type { ProjectsStore } from "@cocalc/frontend/projects/store";
import HelpMeFixButton from "./help-me-fix-button";
import { createMessage, createNavigatorIntentMessage } from "./help-me-fix-utils";

// Re-export getHelp for backward compatibility
export { getHelp } from "./help-me-fix-utils";

interface Props {
  error: string | (() => string); // the error it produced. This is viewed as code.
  line?: string | (() => string); // the line content where the error was produced, if available
  input?: string | (() => string); // the input, e.g., code you ran
  task?: string; // what you're doing, e.g., "ran a cell in a Jupyter notebook" or "ran a code formatter"
  tag?: string;
  language?: string;
  extraFileInfo?: string;
  style?: CSSProperties;
  outerStyle?: CSSProperties;
  size?;
  prioritize?: "start" | "start-end" | "end"; // start: truncate right, start-end: truncate middle, end: truncate left.
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
  const { redux, project_id, path, actions: frameActions } = useFrameContext();
  const [gettingHelp, setGettingHelp] = useState<boolean>(false);
  const [errorGettingHelp, setErrorGettingHelp] = useState<string>("");
  const projectsStore: ProjectsStore = redux.getStore("projects");
  const [model, setModel] = useLanguageModelSetting(project_id);
  const [solutionTokens, setSolutionTokens] = useState<number>(0);
  const [hintTokens, setHintTokens] = useState<number>(0);
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
  const disableChatGPTInProject = !!studentProjectSettings?.get("disableChatGPT");
  const disableSomeChatGPTInProject = !!studentProjectSettings?.get(
    "disableSomeChatGPT",
  );

  // Keep existing policy limits, but allow Codex availability as an alternate
  // capability signal when legacy LLM-vendor checks are false.
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
      model,
      prioritize,
      open: true,
      full,
      isHint: mode === "hint",
      includeModelMention: false,
    });
  }

  const solutionText = createMessageMode("solution");
  const hintText = createMessageMode("hint");

  useAsyncEffect(async () => {
    if (!shouldRender) {
      setSolutionTokens(0);
      setHintTokens(0);
      return;
    }
    // compute the number of tokens (this MUST be a lazy import):
    const { getMaxTokens, numTokensUpperBound } = await import(
      "@cocalc/frontend/misc/llm"
    );

    setSolutionTokens(numTokensUpperBound(solutionText, getMaxTokens(model)));
    setHintTokens(numTokensUpperBound(hintText, getMaxTokens(model)));
  }, [model, solutionText, hintText, shouldRender]);

  if (!shouldRender) {
    return null;
  }

  async function onConfirm(mode: "solution" | "hint") {
    setGettingHelp(true);
    setErrorGettingHelp("");
    try {
      await Promise.resolve(frameActions?.save?.(true));
      const inputText = createMessageMode(mode, true);
      const tagSuffix = mode === "hint" ? "hint" : "solution";
      const sourceTag = `help-me-fix-${tagSuffix}${tag ? `:${tag}` : ""}`;
      const prompt = createNavigatorIntentMessage({
        message: inputText,
        project_id,
        path,
        model,
        isHint: mode === "hint",
        sourceTag,
      });
      dispatchNavigatorPromptIntent({
        prompt,
        tag: `intent:error-fix:${tagSuffix}`,
        forceCodex: true,
      });
      redux?.getProjectActions?.(project_id)?.set_active_tab("home");
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
            model={model}
            setModel={setModel}
            project_id={project_id}
            inputText={solutionText}
            tokens={solutionTokens}
            size={size}
            style={style}
            gettingHelp={gettingHelp}
            onConfirm={() => onConfirm("solution")}
          />
        )}
        {canGetHint && (
          <HelpMeFixButton
            mode="hint"
            model={model}
            setModel={setModel}
            project_id={project_id}
            inputText={hintText}
            tokens={hintTokens}
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
