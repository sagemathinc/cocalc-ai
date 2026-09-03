/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AcpAttentionOption,
  AcpAttentionQuestion,
} from "@cocalc/conat/ai/acp/types";

const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 20;
const MAX_ID_LENGTH = 200;
const MAX_HEADER_LENGTH = 200;
const MAX_QUESTION_LENGTH = 4_000;
const MAX_OPTION_LABEL_LENGTH = 500;
const MAX_OPTION_DESCRIPTION_LENGTH = 2_000;

// Explicit blocking semantics for request_user_input shipped in Codex 0.147.
// Older app servers may expose an earlier shape that CoCalc must not enable in
// Default mode.
export const MIN_CODEX_ATTENTION_INPUT_VERSION = [0, 147, 0] as const;

export function supportsCodexAttentionInput(userAgent: unknown): boolean {
  if (typeof userAgent !== "string") return false;
  const match = userAgent.match(/\/(\d+)\.(\d+)\.(\d+)(?:[-+.(\s]|$)/);
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  for (let i = 0; i < MIN_CODEX_ATTENTION_INPUT_VERSION.length; i += 1) {
    if (version[i] > MIN_CODEX_ATTENTION_INPUT_VERSION[i]) return true;
    if (version[i] < MIN_CODEX_ATTENTION_INPUT_VERSION[i]) return false;
  }
  return true;
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const text = value.trim();
  if (!text) throw new Error(`${name} must not be empty`);
  if (text.length > max) throw new Error(`${name} is too long`);
  return text;
}

function optionalText(
  value: unknown,
  name: string,
  max: number,
): string | undefined {
  if (value == null || value === "") return;
  return requiredText(value, name, max);
}

function normalizeSyncOptions(
  value: unknown,
  questionIndex: number,
): AcpAttentionOption[] | undefined {
  if (value == null) return;
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) {
    throw new Error(`questions[${questionIndex}].options is invalid`);
  }
  return value.map((option, optionIndex) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      throw new Error(
        `questions[${questionIndex}].options[${optionIndex}] is invalid`,
      );
    }
    return {
      label: requiredText(
        (option as any).label,
        `questions[${questionIndex}].options[${optionIndex}].label`,
        MAX_OPTION_LABEL_LENGTH,
      ),
      description: optionalText(
        (option as any).description,
        `questions[${questionIndex}].options[${optionIndex}].description`,
        MAX_OPTION_DESCRIPTION_LENGTH,
      ),
    };
  });
}

export type NormalizedCodexSyncQuestionRequest = {
  threadId: string;
  turnId: string;
  itemId: string;
  isBlocking: boolean;
  autoResolutionMs?: number;
  questions: AcpAttentionQuestion[];
};

export function normalizeCodexSyncQuestionRequest(
  value: unknown,
): NormalizedCodexSyncQuestionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request_user_input params must be an object");
  }
  const params = value as Record<string, unknown>;
  if (
    !Array.isArray(params.questions) ||
    params.questions.length === 0 ||
    params.questions.length > MAX_QUESTIONS
  ) {
    throw new Error("request_user_input questions are missing or excessive");
  }
  if (typeof params.isBlocking !== "boolean") {
    throw new Error("request_user_input isBlocking must be a boolean");
  }
  const ids = new Set<string>();
  const questions = params.questions.map((question, index) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw new Error(`questions[${index}] is invalid`);
    }
    const input = question as Record<string, unknown>;
    if (input.isSecret === true) {
      throw new Error(
        "Secret request_user_input answers are not supported by CoCalc",
      );
    }
    const id = requiredText(input.id, `questions[${index}].id`, MAX_ID_LENGTH);
    if (ids.has(id)) throw new Error(`duplicate question id '${id}'`);
    ids.add(id);
    return {
      id,
      header: requiredText(
        input.header,
        `questions[${index}].header`,
        MAX_HEADER_LENGTH,
      ),
      question: requiredText(
        input.question,
        `questions[${index}].question`,
        MAX_QUESTION_LENGTH,
      ),
      isOther: input.isOther === true || undefined,
      options: normalizeSyncOptions(input.options, index),
    };
  });
  const autoResolutionMs =
    typeof params.autoResolutionMs === "number" &&
    Number.isFinite(params.autoResolutionMs) &&
    params.autoResolutionMs >= 0
      ? Math.floor(params.autoResolutionMs)
      : undefined;
  return {
    threadId: requiredText(params.threadId, "threadId", MAX_ID_LENGTH),
    turnId: requiredText(params.turnId, "turnId", MAX_ID_LENGTH),
    itemId: requiredText(params.itemId, "itemId", MAX_ID_LENGTH),
    isBlocking: params.isBlocking,
    autoResolutionMs,
    questions,
  };
}

export function normalizeCodexAsyncQuestions(
  item: unknown,
): { itemId: string; questions: AcpAttentionQuestion[] } | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return;
  const input = item as Record<string, unknown>;
  if (input.type !== "agentMessage" || input.delivery !== "async") return;
  if (
    !Array.isArray(input.questions) ||
    input.questions.length === 0 ||
    input.questions.length > MAX_QUESTIONS
  ) {
    return;
  }
  const questions = input.questions.map((question, index) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw new Error(`async questions[${index}] is invalid`);
    }
    const value = question as Record<string, unknown>;
    if (value.isSecret === true) {
      throw new Error(
        "Secret asynchronous question answers are not supported by CoCalc",
      );
    }
    const title = requiredText(
      value.title,
      `async questions[${index}].title`,
      MAX_QUESTION_LENGTH,
    );
    let options: AcpAttentionOption[] | undefined;
    if (value.options != null) {
      if (!Array.isArray(value.options) || value.options.length > MAX_OPTIONS) {
        throw new Error(`async questions[${index}].options is invalid`);
      }
      options = value.options.map((option, optionIndex) => ({
        label: requiredText(
          option,
          `async questions[${index}].options[${optionIndex}]`,
          MAX_OPTION_LABEL_LENGTH,
        ),
      }));
    }
    return {
      id: `question-${index + 1}`,
      header: `Question ${index + 1}`,
      question: title,
      isOther: true,
      options,
    };
  });
  return {
    itemId: requiredText(input.id, "async item id", MAX_ID_LENGTH),
    questions,
  };
}

export function validateAttentionAnswers(opts: {
  questions: AcpAttentionQuestion[];
  answers: Record<string, string[]> | undefined;
  decline?: boolean;
}): Record<string, { answers: string[] }> {
  const input = opts.answers ?? {};
  const allowed = new Set(opts.questions.map(({ id }) => id));
  for (const id of Object.keys(input)) {
    if (!allowed.has(id)) throw new Error(`unknown question id '${id}'`);
  }
  const output: Record<string, { answers: string[] }> = {};
  for (const question of opts.questions) {
    const values = input[question.id] ?? [];
    if (!Array.isArray(values) || values.length > MAX_OPTIONS) {
      throw new Error(`answers for '${question.id}' are invalid`);
    }
    const answers = values.map((value, index) =>
      requiredText(
        value,
        `answers['${question.id}'][${index}]`,
        MAX_QUESTION_LENGTH,
      ),
    );
    if (!opts.decline && answers.length === 0) {
      throw new Error(`an answer is required for '${question.id}'`);
    }
    output[question.id] = { answers };
  }
  return output;
}

export const CODEX_SYNC_QUESTION_METHOD = "item/tool/requestUserInput";
