import { getDefaultCodexNewChatDefaults } from "@cocalc/frontend/chat/codex-defaults";
import {
  isCodexModelName,
  resolveCurrentCodexModel,
} from "@cocalc/util/ai/codex";
import {
  dispatchNavigatorPromptIntent,
  stageNavigatorPromptInWorkspaceChat,
  submitNavigatorPromptInWorkspaceChat,
} from "@cocalc/frontend/project/new/navigator-intents";
import { getMaxTokens as getModelMaxTokens } from "@cocalc/util/db-schema/ai-models";
import { backtickSequence } from "@cocalc/frontend/markdown/util";
import { capitalize, trunc_middle } from "@cocalc/util/misc";
import type {
  BaseEditorActions as Actions,
  CodeEditorState,
} from "../base-editor/actions-base";
import {
  agentFileLocation,
  describeAgentFileLocation,
  describeLineRange,
  resolveAgentAbsolutePath,
} from "./agent-file-context";
import { AGENT_CONTEXT_CUTOFF, AI_ASSIST_TAG } from "./consts";
import type { ContextInfo } from "./types";
import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";

export interface Options {
  codegen?: boolean;
  // Type of the frame the request comes from, as known by the frame-tree
  // actions. A cm frame can show a different file than the main editor (a
  // LaTeX `\input`'ed subfile); the request is then built from that file's
  // actions, which do not own the parent frame tree and therefore cannot
  // resolve the frame id themselves.
  frameType?: string;
  command: string;
  allowEmpty?: boolean;
  tag?: string;
  model: string;
  agentSession?: AssistantAgentSessionTarget;
  submitToAgent?: boolean;
  createNewThread?: boolean;
}

// The frame's type: from the frame-tree actions when they told us (see
// Options.frameType), otherwise resolved against the actions we were given.
function resolveFrameType(
  actions: Actions<CodeEditorState>,
  frameId: string,
  options: Options,
): string | undefined {
  return options.frameType ?? actions._get_frame_type(frameId);
}

export type AssistantAgentSessionTarget = Pick<
  AgentSessionRecord,
  | "session_id"
  | "project_id"
  | "account_id"
  | "chat_path"
  | "thread_key"
  | "title"
  | "created_at"
  | "updated_at"
  | "status"
  | "entrypoint"
  | "working_directory"
  | "mode"
  | "model"
  | "reasoning"
  | "serviceTier"
  | "paymentSource"
  | "thread_color"
  | "thread_accent_color"
  | "thread_icon"
  | "thread_image"
>;

interface TerminalAssistantContext {
  terminal_session_id?: string;
  terminal_file_path?: string;
}

export function resolveAssistantCodexModel(model?: string): string {
  return (
    resolveCurrentCodexModel(model) ?? getDefaultCodexNewChatDefaults().model
  );
}

export function getAssistantMaxTokens(model?: string): number {
  return isCodexModelName(model)
    ? 128_000
    : getModelMaxTokens(model as Parameters<typeof getModelMaxTokens>[0]);
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
  const frameType = resolveFrameType(actions, frameId, options);
  const { model } = options;

  const { message } = await createChatMessage(actions, frameId, options, input);
  const codexModel = resolveAssistantCodexModel(model);
  const prompt = createNavigatorAssistantPrompt({
    actions,
    frameId,
    message,
    options,
    codexModel,
  });
  const visiblePrompt = createAssistantVisiblePrompt(options.command);
  const title = createAssistantThreadTitle({
    command: options.command,
    path: actions.path,
    createNewThread: options.createNewThread,
  });
  const intent =
    frameType === "terminal"
      ? "intent:terminal-assistant"
      : "intent:editor-assistant";
  const submitToAgent = options.submitToAgent !== false;
  const sent = submitToAgent
    ? await submitNavigatorPromptInWorkspaceChat({
        project_id: actions.project_id,
        path: actions.path,
        prompt,
        visiblePrompt,
        title,
        tag: intent,
        forceCodex: true,
        agentSession: options.agentSession,
        createNewThread: options.createNewThread,
        openFloating: true,
        waitForAgent: false,
      })
    : await stageNavigatorPromptInWorkspaceChat({
        project_id: actions.project_id,
        path: actions.path,
        prompt,
        visiblePrompt,
        title,
        tag: intent,
        forceCodex: true,
        agentSession: options.agentSession,
        createNewThread: options.createNewThread,
        stageInComposer: true,
        openFloating: true,
        waitForAgent: false,
      });
  if (!sent) {
    dispatchNavigatorPromptIntent({
      prompt,
      visiblePrompt,
      title,
      tag: intent,
      forceCodex: true,
      createNewThread: options.createNewThread,
    });
  }
}

function createAssistantThreadTitle({
  command,
  path,
  createNewThread,
}: {
  command?: string;
  path?: string;
  createNewThread?: boolean;
}): string | undefined {
  if (createNewThread) {
    const trimmedPath = `${path ?? ""}`.trim();
    const basename = trimmedPath.split("/").filter(Boolean).pop();
    if (basename) {
      return `Agent: ${basename}`;
    }
  }
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

  const frameType = resolveFrameType(actions, frameId, options);
  const terminalContext =
    frameType === "terminal"
      ? getTerminalAssistantContext(actions, frameId)
      : undefined;
  if (frameType == "terminal") {
    context = "";
    codegen = false;
  }
  const contextInfo = sanitizeInput(actions, frameId, options, context);
  const input = contextInfo.text;

  // Truncate input (also this MUST lazy import):
  const { truncateMessage } =
    await import("@cocalc/frontend/misc/ai-model-tokens");
  const maxTokens = Math.max(2048, getAssistantMaxTokens(model) - 1000); // reserve output and routing metadata
  const inputOriginalLen = input.length;
  // hard token cap first, then the (much smaller) agent context cutoff: the
  // agent can read the rest of the file itself.
  const truncatedInput = trunc_middle(
    truncateMessage(input, maxTokens),
    AGENT_CONTEXT_CUTOFF,
    "\n\n[... truncated ...]\n\n",
  );
  const inputTruncatedLen = truncatedInput.length;
  // trunc_middle appends its marker to the slices, so the result can be
  // slightly longer than the cutoff -- compare content, not lengths.
  const contextTruncated = truncatedInput !== input;
  // resolve the file once: re-resolving from a location object would lose
  // the project id and fall back to the default project's home directory
  const location = agentFileLocation({
    project_id: actions.project_id,
    path: actions.path,
    line: contextInfo.lineStart,
    line_end: contextInfo.lineEnd,
  });
  const docLocation = {
    path: location.path,
    absolute_path: location.absolute_path,
  };
  const request = createAssistantVisiblePrompt(command);
  const message = [
    `Codex: ${capitalize(command)}.`,
    `User request: ${request}`,
    frameType === "terminal"
      ? "Use the current CoCalc terminal context as the live source of truth."
      : "Inspect the current document through CoCalc live document APIs before editing.",
    frameType !== "terminal"
      ? `The document is ${describeAgentFileLocation(docLocation)}.`
      : undefined,
    frameType !== "terminal" &&
    contextInfo.scope !== "selection" &&
    contextInfo.cursorLine != null
      ? `Nothing is selected; the user's cursor is at line ${contextInfo.cursorLine}${
          contextInfo.cursorColumn != null
            ? `, column ${contextInfo.cursorColumn}`
            : ""
        }, so a vague reference such as "this" most likely means that line or the code around it.`
      : undefined,
    ...describeContextForAgent({
      contextInfo,
      truncatedInput,
      contextTruncated,
      language: actions.languageModelGetLanguage(),
      location,
    }),
    frameType === "terminal" && terminalContext?.terminal_session_id
      ? `This terminal tab is attached to live terminal session \`${terminalContext.terminal_session_id}\`. Use \`cocalc project terminal history <id>\`, \`state <id>\`, \`cwd <id>\`, and \`write <id> ...\` when you need to inspect or interact with this exact session. When sending a shell command, prefer \`cocalc project terminal write <id> --enter -- ...\` so the command actually runs. Use plain \`write\` without \`--enter\` only when you intentionally want to leave input pending at the prompt or inside an interactive program.`
      : undefined,
    frameType === "terminal"
      ? "A `.term` file path alone does not uniquely identify the live terminal session; prefer the session id when operating on the terminal."
      : undefined,
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
        terminal_file_path: terminalContext?.terminal_file_path,
        terminal_session_id: terminalContext?.terminal_session_id,
        language: actions.languageModelGetLanguage(),
        extra_file_info: actions.languageModelExtraFileInfo(codegen),
        absolute_path: location.absolute_path || undefined,
        context_scope: frameType === "terminal" ? undefined : contextInfo.scope,
        context_line_start: location.line,
        context_line_end: location.line_end,
        cursor_line:
          frameType === "terminal" ? undefined : contextInfo.cursorLine,
        cursor_column:
          frameType === "terminal" ? undefined : contextInfo.cursorColumn,
        context_chars: inputOriginalLen,
        truncated_context_chars: inputTruncatedLen,
      },
      null,
      2,
    ),
    "```",
  ]
    .filter(Boolean)
    .join("\n\n");
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
  const frameType = resolveFrameType(actions, frameId, options);
  const terminalContext =
    frameType === "terminal"
      ? getTerminalAssistantContext(actions, frameId)
      : undefined;
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
      absolute_path:
        resolveAgentAbsolutePath(actions.project_id, actions.path) || undefined,
      frame_type: frameType,
      terminal_file_path: terminalContext?.terminal_file_path,
      terminal_session_id: terminalContext?.terminal_session_id,
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
    frameType === "terminal" && terminalContext?.terminal_session_id
      ? `The current terminal frame is attached to live session \`${terminalContext.terminal_session_id}\`. Prefer \`cocalc project terminal history <id>\`, \`cwd <id>\`, \`state <id>\`, and \`write <id> ...\` when you need to inspect or act on this terminal. When sending a shell command, use \`cocalc project terminal write <id> --enter -- ...\` unless you intentionally want to leave input pending.`
      : undefined,
    "Treat the live in-memory sync version of the current document as the source of truth whenever a live document API exists.",
    "Do not assume the filesystem copy is current.",
    "Apply edits directly when safe, run checks as needed, and summarize exactly what changed.",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    message,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function getTerminalAssistantContext(
  actions: Actions<CodeEditorState>,
  frameId: string,
): TerminalAssistantContext {
  const terminal =
    typeof (actions as any)?.get_terminal === "function"
      ? (actions as any).get_terminal(frameId)
      : undefined;
  const terminal_session_id =
    typeof terminal?.getSessionId === "function"
      ? terminal.getSessionId()
      : undefined;
  return {
    terminal_file_path: actions.path,
    terminal_session_id,
  };
}

function sanitizeInput(
  actions: Actions<CodeEditorState>,
  frameId: string,
  options: Options,
  input: string | undefined,
): ContextInfo {
  const { allowEmpty } = options;
  const frameType = resolveFrameType(actions, frameId, options);
  if (frameType == "terminal") {
    return { text: "", scope: "none" };
  }
  // Ask the editor where the context comes from (scope + line range); only
  // trust that location if it describes the text we are actually sending.
  const info: ContextInfo | undefined =
    typeof actions.languageModelGetContextInfo === "function"
      ? actions.languageModelGetContextInfo(frameId)
      : undefined;
  if (input == null) {
    input = info?.text ?? actions.languageModelGetContext(frameId);
  }
  if (!input && !allowEmpty) {
    throw Error("Please write or select something.");
  }
  if (info != null && info.text === input) {
    return info;
  }
  return { text: input, scope: info?.scope ?? "all" };
}

// Lines describing the document context for the agent: the (possibly
// truncated) text itself plus a precise pointer to where it lives.
function describeContextForAgent({
  contextInfo,
  truncatedInput,
  contextTruncated,
  language,
  location,
}: {
  contextInfo: ContextInfo;
  truncatedInput: string;
  contextTruncated: boolean;
  language: string;
  location: { line?: number; line_end?: number };
}): string[] {
  if (!truncatedInput) return [];
  const range = describeLineRange(location);
  const what =
    contextInfo.scope === "selection"
      ? "The user's current selection"
      : contextInfo.scope === "all"
        ? "The document content"
        : `The current ${contextInfo.scope}`;
  const where = range ? ` (${range} of the document)` : "";
  const note = contextTruncated
    ? " It is truncated in the middle; read the file for the full content."
    : "";
  const delim = backtickSequence(truncatedInput);
  return [
    `${what}${where} is:${note}`,
    `${delim}${language}\n${truncatedInput}\n${delim}`,
  ];
}
