/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  normalizeCodexAsyncQuestions,
  normalizeCodexSyncQuestionRequest,
  supportsCodexAttentionInput,
  validateAttentionAnswers,
} from "../codex-attention";

describe("Codex attention protocol validation", () => {
  it.each([
    ["codex_cli_rs/0.151.0", true],
    ["codex_cli_rs/0.147.0", true],
    ["codex_cli_rs/0.147.0-alpha.9", true],
    ["codex_cli_rs/0.146.9", false],
    ["custom_originator/1.0.0 (Linux)", true],
    ["codex_cli_rs/development", false],
    [undefined, false],
  ])("version-gates attention input for %s", (userAgent, supported) => {
    expect(supportsCodexAttentionInput(userAgent)).toBe(supported);
  });

  it("preserves blocking state and bounded question metadata", () => {
    expect(
      normalizeCodexSyncQuestionRequest({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: false,
        autoResolutionMs: 1_234.8,
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Which deployment?",
            options: [{ label: "Staging", description: "Lower risk" }],
          },
        ],
      }),
    ).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      isBlocking: false,
      autoResolutionMs: 1_234,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Which deployment?",
          options: [{ label: "Staging", description: "Lower risk" }],
        },
      ],
    });
  });

  it.each([
    ["missing blocking state", { isBlocking: undefined }],
    ["duplicate ids", { duplicate: true }],
    ["secret question", { isSecret: true }],
  ])("rejects %s", (_label, variant) => {
    const second = (variant as any).duplicate
      ? [{ id: "choice", header: "Again", question: "Again?" }]
      : [];
    expect(() =>
      normalizeCodexSyncQuestionRequest({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: (variant as any).isBlocking ?? true,
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Which deployment?",
            isSecret: (variant as any).isSecret,
          },
          ...second,
        ],
        ...((variant as any).isBlocking === undefined &&
        Object.prototype.hasOwnProperty.call(variant, "isBlocking")
          ? { isBlocking: undefined }
          : {}),
      }),
    ).toThrow();
  });

  it("only recognizes explicit asynchronous structured question messages", () => {
    expect(
      normalizeCodexAsyncQuestions({
        id: "message-1",
        type: "agentMessage",
        delivery: "async",
        questions: [{ title: "Choose a region", options: ["EU", "US"] }],
      }),
    ).toEqual({
      itemId: "message-1",
      questions: [
        {
          id: "question-1",
          header: "Question 1",
          question: "Choose a region",
          isOther: true,
          options: [{ label: "EU" }, { label: "US" }],
        },
      ],
    });
    expect(
      normalizeCodexAsyncQuestions({
        id: "message-2",
        type: "agentMessage",
        delivery: "final",
        questions: [{ title: "Is this prose a question?" }],
      }),
    ).toBeUndefined();
    expect(() =>
      normalizeCodexAsyncQuestions({
        id: "message-3",
        type: "agentMessage",
        delivery: "async",
        questions: [{ title: "Enter a secret", isSecret: true }],
      }),
    ).toThrow("Secret asynchronous question answers are not supported");
  });

  it("validates every answer and rejects unknown question ids", () => {
    const questions = [
      { id: "region", header: "Region", question: "Which region?" },
    ];
    expect(
      validateAttentionAnswers({
        questions,
        answers: { region: ["EU"] },
      }),
    ).toEqual({ region: { answers: ["EU"] } });
    expect(() =>
      validateAttentionAnswers({
        questions,
        answers: { other: ["US"] },
      }),
    ).toThrow("unknown question id");
    expect(() => validateAttentionAnswers({ questions, answers: {} })).toThrow(
      "an answer is required",
    );
  });

  it("rejects custom values when a question disallows other answers", () => {
    const questions = [
      {
        id: "region",
        header: "Region",
        question: "Which region?",
        options: [{ label: "EU" }, { label: "US" }],
      },
    ];
    expect(
      validateAttentionAnswers({
        questions,
        answers: { region: ["EU"] },
      }),
    ).toEqual({ region: { answers: ["EU"] } });
    expect(() =>
      validateAttentionAnswers({
        questions,
        answers: { region: ["APAC"] },
      }),
    ).toThrow("must use the provided options");
    expect(() =>
      validateAttentionAnswers({
        questions: [{ ...questions[0], isOther: true }],
        answers: { region: ["APAC"] },
      }),
    ).not.toThrow();
  });
});
