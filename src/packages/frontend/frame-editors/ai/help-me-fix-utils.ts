import { backtickSequence } from "@cocalc/frontend/markdown/util";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptInWorkspaceChat,
} from "@cocalc/frontend/project/new/navigator-intents";
import {
  BUILDABLE_EXTENSIONS,
  isBuildableDocument,
} from "@cocalc/util/document-build";
import { trunc, trunc_left, trunc_middle } from "@cocalc/util/misc";
import {
  agentFileLocation,
  describeAgentFileLocation,
  type AgentFileLocation,
} from "./agent-file-context";
import { CUTOFF } from "./consts";
import shortenError from "./shorten-error";

export interface GetHelpOptions {
  project_id: string;
  path: string;
  tag?: string;
  error: string;
  input?: string;
  task?: string;
  line?: string;
  language?: string;
  extraFileInfo?: string;
  redux: any;
  prioritize?: "start" | "start-end" | "end";
  model?: string;
  isHint?: boolean;
  // where the error is located (file + line); agents have full project
  // access, so a precise pointer matters more than pasted context.
  location?: AgentFileLocation;
  // the command that produced the error (e.g. the LaTeX build command)
  buildCommand?: string;
}

export interface CreateMessageOpts {
  tag?: string;
  error: string;
  line: string;
  input?: string;
  task?: string;
  language?: string;
  extraFileInfo?: string;
  prioritize?: "start" | "start-end" | "end";
  model?: string;
  isHint?: boolean;
  includeModelMention?: boolean;
  location?: AgentFileLocation;
}

export async function getHelp({
  project_id,
  path,
  tag,
  line = "",
  error,
  input,
  task,
  language,
  extraFileInfo,
  redux: _redux,
  prioritize,
  isHint = false,
  location,
  buildCommand,
}: GetHelpOptions) {
  const resolvedLocation = location ?? agentFileLocation({ project_id, path });
  const messageText = createMessage({
    error,
    task,
    line,
    input,
    language,
    extraFileInfo,
    prioritize,
    isHint,
    location: resolvedLocation,
  });

  try {
    const tagSuffix = isHint ? "hint" : "solution";
    const visiblePrompt = isHint
      ? "Diagnose this problem and give me a hint."
      : "Diagnose this problem and fix it.";
    const intentPrompt = createNavigatorIntentMessage({
      message: messageText,
      project_id,
      path,
      isHint,
      sourceTag: `help-me-fix-${tagSuffix}${tag ? `:${tag}` : ""}`,
      location: resolvedLocation,
      buildCommand,
    });
    const sent = await submitNavigatorPromptInWorkspaceChat({
      project_id,
      path,
      prompt: intentPrompt,
      visiblePrompt,
      title: isHint ? "Get debugging hint" : "Fix problem",
      tag: `intent:error-fix:${tagSuffix}`,
      forceCodex: true,
      openFloating: true,
      waitForAgent: false,
    });
    if (!sent) {
      dispatchNavigatorPromptIntent({
        prompt: intentPrompt,
        visiblePrompt,
        title: isHint ? "Get debugging hint" : "Fix problem",
        tag: `intent:error-fix:${tagSuffix}`,
        forceCodex: true,
      });
    }
  } catch (err) {
    console.error("Error getting help:", err);
    throw err;
  }
}

export function createMessage({
  error,
  line,
  language,
  input,
  task,
  extraFileInfo,
  prioritize,
  isHint = false,
  location,
}: CreateMessageOpts): string {
  const message: string[] = [];
  if (isHint) {
    message.push(
      "Please give me a hint to help me fix my code. Do not provide the complete solution - just point me in the right direction.",
    );
  } else {
    message.push("Help me fix my code.");
  }

  if (task) {
    message.push(`I ${task}.`);
  }

  error = trimStr(error, language);
  line = trimStr(line, language);

  if (location?.path) {
    message.push(`The problem is in ${describeAgentFileLocation(location)}.`);
  }

  message.push(`I received the following error:`);
  const delimE = backtickSequence(error);
  message.push(`${delimE}${language}\n${error}\n${delimE}`);

  if (line) {
    message.push(`For the following line:`);
    const delimL = backtickSequence(line);
    message.push(`${delimL}${language}\n${line}\n${delimL}`);
  }

  if (input) {
    if (input.length < CUTOFF) {
      message.push(`My ${extraFileInfo ?? ""} contains:`);
    } else {
      if (prioritize === "start-end") {
        input = trunc_middle(input, CUTOFF, "\n\n[...]\n\n");
      } else if (prioritize === "end") {
        input = trunc_left(input, CUTOFF);
      } else {
        input = trunc(input, CUTOFF);
      }
      const describe =
        prioritize === "start"
          ? "starts"
          : prioritize === "end"
            ? "ends"
            : "starts and ends";
      message.push(
        `My ${
          extraFileInfo ?? ""
        } code ${describe} as follows, but is too long to fully include here:`,
      );
    }
    const delimI = backtickSequence(input);
    message.push(`${delimI}${language}\n${input}\n${delimI}`);
  }

  return message.join("\n\n");
}

interface CreateNavigatorIntentMessageOpts {
  message: string;
  project_id: string;
  path: string;
  model?: string;
  isHint: boolean;
  sourceTag: string;
  location?: AgentFileLocation;
  buildCommand?: string;
}

/*
The hidden prompt behind "Fix with Agent".

The build instruction names `cocalc project build` and its `--wait` flag
verbatim; that command is defined in
@cocalc/cli/bin/commands/project/build.ts, which carries a note pointing back
here.  Keep the two in step -- nothing checks this at build time, the agent
simply calls a command that no longer exists.
*/
export function createNavigatorIntentMessage({
  message,
  project_id,
  path,
  isHint,
  sourceTag,
  location,
  buildCommand,
}: CreateNavigatorIntentMessageOpts): string {
  const docLocation = agentFileLocation({ project_id, path });
  const errorLocation = location ?? docLocation;
  // help-me-fix also runs on notebooks, scripts and terminal output, where
  // there is no build to re-run and the instructions below are just noise
  const buildable = isBuildableDocument(path);
  // `cocalc project build` takes an absolute path
  const buildPath = docLocation.absolute_path || path;
  const metadata = {
    source: "help-me-fix",
    intent: "intent:error-fix",
    goal: isHint
      ? "Diagnose issue and provide a hint-first fix plan."
      : "Diagnose issue, apply fixes directly when safe, and verify the result.",
    context: {
      project_id,
      path,
      absolute_path: docLocation.absolute_path,
      error_file: errorLocation.path,
      error_absolute_path: errorLocation.absolute_path,
      error_line: errorLocation.line,
      error_line_end: errorLocation.line_end,
      build_command: `${buildCommand ?? ""}`.trim() || undefined,
      source_tag: sourceTag,
    },
    mutation_mode: "in-place-edit",
    permissions_hint: "workspace-write",
    ...(buildable
      ? {
          post_fix_build: {
            command: "cocalc project build <path> --wait",
            fallback: "cocalc browser exec 'await api.editor.build(<path>)'",
            applies_to: [...BUILDABLE_EXTENSIONS],
          },
        }
      : {}),
  };
  return [
    "Handle this CoCalc help-me-fix request as an agent.",
    `The document being edited is ${describeAgentFileLocation(docLocation)}.`,
    errorLocation.path && errorLocation.path !== docLocation.path
      ? `The error itself is reported in ${describeAgentFileLocation(errorLocation)}.`
      : undefined,
    "Treat the live in-memory sync version of the document as the source of truth.",
    "Do not rely on the filesystem copy being current; use live document APIs when available.",
    "Apply edits directly when safe, run checks as needed, and summarize exactly what changed.",
    buildable
      ? `Re-run the build through the editor after applying the fix: \`cocalc project build ${JSON.stringify(buildPath)} --wait\`. Do not run latexmk, quarto or the \`build_command\` below in a shell yourself: that leaves the editor's build log and error panel showing the previous failure, so the UI would contradict your report.`
      : undefined,
    buildable
      ? "That command asks the project for a build, the open editors rerun it and refresh their build log and error panel, and --wait returns the resulting exit_code and log. Use that exit code as the verification of your fix. If the CLI is unavailable, fall back to browser exec: `await api.editor.build(<path>)`."
      : undefined,
    [
      "Intent metadata:",
      "```json",
      JSON.stringify(metadata, null, 2),
      "```",
    ].join("\n"),
    message,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function trimStr(s: string, language): string {
  if (s.length > 3000) {
    s = shortenError(s, language);
    if (s.length > 3000) {
      s = trunc_middle(s, 3000);
    }
  }
  return s;
}
