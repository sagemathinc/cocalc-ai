import {
  formatCodexErrorForDisplay,
  formatCodexErrorMarkdown,
  CODEX_LITE_UPGRADE_HINT,
  CODEX_LITE_UPGRADE_TITLE,
  CODEX_PROJECT_RESTART_HINT,
  CODEX_PROJECT_RESTART_TITLE,
} from "../codex-error-presentation";
import { unavailableChatGptCodexModel } from "@cocalc/util/ai/codex-model-recovery";

it("recognizes only the specific ChatGPT model rejection and hides raw error markup", () => {
  const error = `<span style='color:red'>{"type":"error","status":400,"message":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}</span>`;
  expect(unavailableChatGptCodexModel(error)).toBe("gpt-5.6-sol");
  expect(formatCodexErrorMarkdown(error)).toContain(
    "Choose an available model",
  );
  expect(formatCodexErrorMarkdown(error)).not.toContain("<span");
  const explanation = `Here is an explanation of this error: ${error}\nMore useful information.`;
  expect(formatCodexErrorMarkdown(explanation, false, false)).toBe(explanation);
  for (const other of [
    "model not found",
    "rate limit",
    "authentication expired",
    "network unavailable",
    "unsupported reasoning effort",
  ]) {
    expect(unavailableChatGptCodexModel(other)).toBeUndefined();
    expect(formatCodexErrorForDisplay(other)).toBe(other);
  }
});

describe("Codex error presentation", () => {
  const error = JSON.stringify({
    type: "error",
    status: 400,
    error: {
      type: "invalid_request_error",
      message:
        "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
    },
  });

  it("replaces outdated Codex errors with a project restart solution", () => {
    expect(formatCodexErrorForDisplay(error)).toBe(
      `${CODEX_PROJECT_RESTART_TITLE} ${CODEX_PROJECT_RESTART_HINT}`,
    );
  });

  it("formats the project restart solution for assistant Markdown", () => {
    expect(formatCodexErrorMarkdown(error)).toBe(
      `**${CODEX_PROJECT_RESTART_TITLE}**\n\n${CODEX_PROJECT_RESTART_HINT}`,
    );
  });

  it("turns unknown feature flags from an old Codex into restart guidance", () => {
    const featureError =
      "codex app-server exited unexpectedly: 1; stderr: Error: Unknown feature flag: background_paginated_rollout_migration";

    expect(formatCodexErrorMarkdown(featureError)).toBe(
      `**${CODEX_PROJECT_RESTART_TITLE}**\n\n${CODEX_PROJECT_RESTART_HINT}`,
    );
  });

  it("tells Lite users to upgrade Codex instead of restarting", () => {
    const featureError =
      "Error: Unknown feature flag: background_paginated_rollout_migration";

    expect(formatCodexErrorForDisplay(featureError, true)).toBe(
      `${CODEX_LITE_UPGRADE_TITLE} ${CODEX_LITE_UPGRADE_HINT}`,
    );
    expect(formatCodexErrorMarkdown(featureError, true)).toBe(
      `**${CODEX_LITE_UPGRADE_TITLE}**\n\n${CODEX_LITE_UPGRADE_HINT}`,
    );
  });

  it("leaves unrelated errors unchanged", () => {
    expect(formatCodexErrorForDisplay("Codex is not signed in")).toBe(
      "Codex is not signed in",
    );
    expect(formatCodexErrorMarkdown("Codex is not signed in")).toBe(
      "Codex is not signed in",
    );
  });
});
