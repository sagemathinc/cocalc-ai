import {
  DEFAULT_CODEX_MODEL_NAME,
  DEFAULT_CODEX_MODELS,
  isCodexModelName,
} from "@cocalc/util/ai/codex";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptToCurrentThread,
} from "@cocalc/frontend/project/new/navigator-intents";
import { getMaxTokens as getLLMMaxTokens } from "@cocalc/util/db-schema/llm-utils";
import { capitalize } from "@cocalc/util/misc";
import type {
  BaseEditorActions as Actions,
  CodeEditorState,
} from "../base-editor/actions-base";
import { AI_ASSIST_TAG } from "./consts";

export interface Options {
  codegen?: boolean;
  command: string;
  allowEmpty?: boolean;
  tag?: string;
  model: string;
}

export const DEFAULT_ASSISTANT_CODEX_MODEL =
  DEFAULT_CODEX_MODELS.find((model) => model.name === "gpt-5.4-mini")?.name ??
  DEFAULT_CODEX_MODEL_NAME;

export function resolveAssistantCodexModel(model?: string): string {
  const normalized = `${model ?? ""}`.trim();
  return isCodexModelName(normalized)
    ? normalized
    : DEFAULT_ASSISTANT_CODEX_MODEL;
}

export function getAssistantMaxTokens(model?: string): number {
  return isCodexModelName(model)
    ? 128_000
    : getLLMMaxTokens(model as Parameters<typeof getLLMMaxTokens>[0]);
}

export default async function createChat({
  actions,
  frameId,
  options,
  input,
}: {
  actions: Actions<CodeEditorState>;
  frameId: string;
  options: Options;
  input?: string;
}): Promise<void> {
  const frameType = actions._get_frame_type(frameId);
  const { model } = options;

  const visiblePrompt = createAssistantVisiblePrompt(options.command);
  const { message } = await createChatMessage(actions, frameId, options, input);
  const codexModel = resolveAssistantCodexModel(model);
  const prompt = createNavigatorAssistantPrompt({
    actions,
    frameId,
    message,
    options,
    codexModel,
  });
  const title = createAssistantThreadTitle(options.command);
  const intent =
    frameType === "terminal"
      ? "intent:terminal-assistant"
      : "intent:editor-assistant";
  const sent = await submitNavigatorPromptToCurrentThread({
    project_id: actions.project_id,
    path: actions.path,
    prompt,
    visiblePrompt,
    title,
    tag: intent,
    forceCodex: true,
    codexConfig: { model: codexModel },
    openFloating: true,
    createNewThread: true,
  });
  if (!sent) {
    dispatchNavigatorPromptIntent({
      prompt,
      visiblePrompt,
      title,
      tag: intent,
      forceCodex: true,
      createNewThread: true,
      codexConfig: { model: codexModel },
    });
  }
}

function createAssistantThreadTitle(command?: string): string | undefined {
  const trimmed = `${command ?? ""}`.trim();
  if (!trimmed) return;
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77).trim()}...`;
}

function createAssistantVisiblePrompt(command?: string): string {
  const trimmed = `${command ?? ""}`.trim();
  return trimmed || "Help with this document";
}

export async function createChatMessage(
  actions: Actions<CodeEditorState>,
  frameId: string,
  options: Options,
  context: string | undefined,
): Promise<{
  message: string;
  inputOriginalLen: number;
  inputTruncatedLen: number;
}> {
  let { codegen } = options;
  const { command, model } = options;

  const frameType = actions._get_frame_type(frameId);
  if (frameType == "terminal") {
    context = "";
    codegen = false;
  }
  const input = sanitizeInput(actions, frameId, options, context);

  // Truncate input (also this MUST lazy import):
  const { truncateMessage } = await import("@cocalc/frontend/misc/llm");
  const maxTokens = Math.max(2048, getAssistantMaxTokens(model) - 1000); // reserve output and routing metadata
  const inputOriginalLen = input.length;
  const truncatedInput = truncateMessage(input, maxTokens);
  const inputTruncatedLen = truncatedInput.length;
  const request = createAssistantVisiblePrompt(command);
  const message = [
    `Codex: ${capitalize(command)}.`,
    `User request: ${request}`,
    frameType === "terminal"
      ? "Use the current CoCalc terminal context as the live source of truth."
      : "Inspect the current document through CoCalc live document APIs before editing.",
    "Treat the live in-memory sync state as authoritative whenever it is available.",
    "Do not assume the filesystem copy is current.",
    "Use the metadata below only to locate the target, not as a substitute for reading live content.",
    "```json",
    JSON.stringify(
      {
        source:
          frameType === "terminal" ? "terminal-assistant" : "editor-assistant",
        frame_type: frameType,
        path: actions.path,
        language: actions.languageModelGetLanguage(),
        extra_file_info: actions.languageModelExtraFileInfo(codegen),
        context_chars: inputOriginalLen,
        truncated_context_chars: inputTruncatedLen,
      },
      null,
      2,
    ),
    "```",
  ].join("\n\n");
  return { message, inputOriginalLen, inputTruncatedLen };
}

function createNavigatorAssistantPrompt({
  actions,
  frameId,
  message,
  options,
  codexModel,
}: {
  actions: Actions<CodeEditorState>;
  frameId: string;
  message: string;
  options: Options;
  codexModel: string;
}): string {
  const frameType = actions._get_frame_type(frameId);
  const source =
    frameType === "terminal" ? "terminal-assistant" : "editor-assistant";
  const intent =
    frameType === "terminal"
      ? "intent:terminal-assistant"
      : "intent:editor-assistant";
  const metadata = {
    source,
    intent,
    goal:
      frameType === "terminal"
        ? "Use Codex to help with the current terminal task and apply safe command-driven changes when appropriate."
        : "Use Codex to explain, review, or edit the current document directly when safe.",
    context: {
      project_id: actions.project_id,
      path: actions.path,
      frame_type: frameType,
      language: actions.languageModelGetLanguage(),
      requested_model: options.model,
      codex_model: codexModel,
      source_tag: `${AI_ASSIST_TAG}-${options.tag ?? options.command}`,
    },
    mutation_mode: frameType === "terminal" ? "run-command" : "in-place-edit",
    permissions_hint: "workspace-write",
  };
  return [
    "Handle this CoCalc assistant request as a Codex agent.",
    `Visible user request: ${createAssistantVisiblePrompt(options.command)}`,
    "Treat the live in-memory sync version of the current document as the source of truth whenever a live document API exists.",
    "Do not assume the filesystem copy is current.",
    "Apply edits directly when safe, run checks as needed, and summarize exactly what changed.",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    message,
  ].join("\n\n");
}

function sanitizeInput(
  actions: Actions<CodeEditorState>,
  frameId: string,
  options: Options,
  input: string | undefined,
): string {
  let { allowEmpty } = options;
  const frameType = actions._get_frame_type(frameId);
  if (frameType == "terminal") {
    input = "";
    allowEmpty = true;
  } else {
    if (input == null) {
      input = actions.languageModelGetContext(frameId);
    }
    if (!input && !allowEmpty) {
      throw Error("Please write or select something.");
    }
  }
  if (input == null) {
    throw Error("bug");
  }
  return input;
}
