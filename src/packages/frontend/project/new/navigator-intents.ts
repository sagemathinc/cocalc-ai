import { uuid } from "@cocalc/util/misc";

const NAVIGATOR_INTENT_QUEUE_KEY = "cocalc:navigator:intent-queue";
export const NAVIGATOR_SUBMIT_PROMPT_EVENT =
  "cocalc:navigator:submit-prompt";

export interface NavigatorSubmitPromptDetail {
  id: string;
  createdAt: string;
  prompt: string;
  tag?: string;
  forceCodex?: boolean;
}

function readQueue(): NavigatorSubmitPromptDetail[] {
  try {
    const raw = localStorage.getItem(NAVIGATOR_INTENT_QUEUE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item) =>
        typeof item?.id === "string" && typeof item?.prompt === "string",
    );
  } catch {
    return [];
  }
}

function writeQueue(queue: NavigatorSubmitPromptDetail[]): void {
  try {
    if (queue.length === 0) {
      localStorage.removeItem(NAVIGATOR_INTENT_QUEUE_KEY);
    } else {
      localStorage.setItem(NAVIGATOR_INTENT_QUEUE_KEY, JSON.stringify(queue));
    }
  } catch {}
}

export function queueNavigatorPromptIntent(
  intent: NavigatorSubmitPromptDetail,
): void {
  const queue = readQueue();
  queue.push(intent);
  writeQueue(queue);
}

export function takeQueuedNavigatorPromptIntents(): NavigatorSubmitPromptDetail[] {
  const queue = readQueue();
  writeQueue([]);
  return queue;
}

export function removeQueuedNavigatorPromptIntent(id: string): void {
  const queue = readQueue().filter((item) => item.id !== id);
  writeQueue(queue);
}

export function createNavigatorPromptIntent(opts: {
  prompt: string;
  tag?: string;
  forceCodex?: boolean;
}): NavigatorSubmitPromptDetail {
  return {
    id: uuid(),
    createdAt: new Date().toISOString(),
    prompt: opts.prompt,
    tag: opts.tag,
    forceCodex: opts.forceCodex ?? true,
  };
}

export function dispatchNavigatorPromptIntent(opts: {
  prompt: string;
  tag?: string;
  forceCodex?: boolean;
}): NavigatorSubmitPromptDetail {
  const intent = createNavigatorPromptIntent(opts);
  queueNavigatorPromptIntent(intent);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(NAVIGATOR_SUBMIT_PROMPT_EVENT, { detail: intent }),
    );
  }
  return intent;
}
