import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFundingHint } from "./compute-funding-hint";
import { emitError } from "./cli-output";

test("funding hints distinguish unsupported home scope, payer routing, and human account authority", () => {
  assert.match(
    computeFundingHint(
      "vm personal-funding preview",
      "funding_unavailable",
      "Personal home-volume handoff is not yet available.",
    )!,
    /Do not omit attached volume scope/,
  );
  assert.match(
    computeFundingHint(
      "vm personal-funding status",
      "account_auth_required",
      "account required",
    )!,
    /never share passwords/,
  );
  assert.match(
    computeFundingHint(
      "compute-funding sources",
      "funding_home_bay_required",
      "wrong bay",
    )!,
    /authoritative home-bay/,
  );
  assert.equal(
    computeFundingHint("project create", "funding_unavailable", "unknown"),
    undefined,
  );
  assert.equal(
    computeFundingHint("vm create", "provider_failed", "failed"),
    undefined,
  );
});
test("VM funding error guidance preserves structured codes/messages and higher-priority approval hints", () => {
  for (const [code, message, expected] of [
    ["funding_unavailable", "Current allowance unavailable", /--funding-payer/],
    ["fresh_auth_required", "fresh auth is required", /cocalc auth elevate/],
    [
      "agent_grant_required",
      "approval required",
      /Approve this exact VM request/,
    ],
  ] as const) {
    const original = console.error;
    const lines: string[] = [];
    console.error = (line: string) => {
      lines.push(line);
    };
    try {
      emitError(
        { globals: { output: "json" } },
        "vm create",
        Object.assign(Error(message), {
          code,
          ...(code === "agent_grant_required"
            ? { approval_url: "https://approval.example.invalid/isolated" }
            : {}),
        }),
        (value) => value,
      );
    } finally {
      console.error = original;
    }
    const result = JSON.parse(lines.join("\n"));
    assert.equal(result.error.code, code);
    assert.equal(result.error.message, message);
    assert.match(result.error.hint, expected);
  }
});
