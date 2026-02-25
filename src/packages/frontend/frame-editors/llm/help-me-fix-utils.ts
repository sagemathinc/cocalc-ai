import { backtickSequence } from "@cocalc/frontend/markdown/util";
import { dispatchNavigatorPromptIntent } from "@cocalc/frontend/project/new/navigator-intents";
import { trunc, trunc_left, trunc_middle } from "@cocalc/util/misc";
import { CUTOFF } from "./consts";
import { modelToMention } from "./llm-selector";
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
  model: string;
  isHint?: boolean;
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
  model: string;
  open: boolean;
  full: boolean;
  isHint?: boolean;
  includeModelMention?: boolean;
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
  redux,
  prioritize,
  model,
  isHint = false,
}: GetHelpOptions) {
  const messageText = createMessage({
    error,
    task,
    line,
    input,
    language,
    extraFileInfo,
    model,
    prioritize,
    open: true,
    full: true,
    isHint,
    includeModelMention: false,
  });

  try {
    const tagSuffix = isHint ? "hint" : "solution";
    const intentPrompt = createNavigatorIntentMessage({
      message: messageText,
      project_id,
      path,
      model,
      isHint,
      sourceTag: `help-me-fix-${tagSuffix}${tag ? `:${tag}` : ""}`,
    });
    dispatchNavigatorPromptIntent({
      prompt: intentPrompt,
      tag: `intent:error-fix:${tagSuffix}`,
      forceCodex: true,
    });
    redux?.getProjectActions?.(project_id)?.set_active_tab("home");
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
  model,
  task,
  extraFileInfo,
  prioritize,
  open,
  full,
  isHint = false,
  includeModelMention = full,
}: CreateMessageOpts): string {
  const message: string[] = [];
  const prefix = includeModelMention ? modelToMention(model) + " " : "";
  if (isHint) {
    message.push(
      `${prefix}Please give me a hint to help me fix my code. Do not provide the complete solution - just point me in the right direction.`,
    );
  } else {
    message.push(`${prefix}Help me fix my code.`);
  }

  if (full)
    message.push(`<details${open ? " open" : ""}><summary>Context</summary>`);

  if (task) {
    message.push(`I ${task}.`);
  }

  error = trimStr(error, language);
  line = trimStr(line, language);

  message.push(`I received the following error:`);
  const delimE = backtickSequence(error);
  message.push(`${delimE}${language}\n${error}\n${delimE}`);

  if (line) {
    message.push(`For the following line:`);
    const delimL = backtickSequence(line);
    message.push(`${delimL}${language}\n${line}\n${delimL}`);
  }

  // We put the input last, since it could be huge and get truncated.
  // It's much more important to show the error, obviously.
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

  if (full) message.push("</details>");

  return message.join("\n\n");
}

interface CreateNavigatorIntentMessageOpts {
  message: string;
  project_id: string;
  path: string;
  model: string;
  isHint: boolean;
  sourceTag: string;
}

export function createNavigatorIntentMessage({
  message,
  project_id,
  path,
  model,
  isHint,
  sourceTag,
}: CreateNavigatorIntentMessageOpts): string {
  const metadata = {
    source: "help-me-fix",
    intent: "intent:error-fix",
    goal: isHint
      ? "Diagnose issue and provide a hint-first fix plan."
      : "Diagnose issue, apply fixes directly when safe, and verify the result.",
    context: {
      project_id,
      path,
      preferred_model: model,
      source_tag: sourceTag,
    },
    mutation_mode: "in-place-edit",
    permissions_hint: "workspace-write",
  };
  return [
    "Handle this CoCalc help-me-fix request as an agent.",
    "Apply edits directly when safe, run checks as needed, and summarize exactly what changed.",
    "<details><summary>Intent metadata</summary>",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "</details>",
    message,
  ].join("\n\n");
}

function trimStr(s: string, language): string {
  if (s.length > 3000) {
    // 3000 is about 500 tokens
    // This uses structure:
    s = shortenError(s, language);
    if (s.length > 3000) {
      // this just puts ... in the middle.
      s = trunc_middle(s, 3000);
    }
  }
  return s;
}
