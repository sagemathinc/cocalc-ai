import {
  claudeOAuthTokenFromOutput,
  claudeOAuthTokenLine,
  claudeSubscriptionToken,
  looksLikeClaudeSecret,
  packClaudeSubscriptionToken,
} from "./claude-subscription-token";

const token = `sk-ant-oat01-${"a1_B-".repeat(12)}`;

test("finds the last complete token in terminal output", () => {
  expect(
    claudeOAuthTokenFromOutput(
      `Your OAuth token:\n${token}\nStore it.`,
      "code#1",
    ),
  ).toBe(token);
  expect(claudeOAuthTokenFromOutput("sk-ant-oat01-short", "")).toBeUndefined();
  expect(claudeOAuthTokenFromOutput("no token here", "")).toBeUndefined();
});

test("token payloads round trip; home snapshots are not tokens", () => {
  expect(claudeSubscriptionToken(packClaudeSubscriptionToken(token))).toBe(
    token,
  );
  expect(
    claudeSubscriptionToken(JSON.stringify({ version: 1, files: [] })),
  ).toBeUndefined();
  expect(() => packClaudeSubscriptionToken("sk-ant-api03-key")).toThrow();
  expect(() =>
    claudeSubscriptionToken(JSON.stringify({ version: 2, oauth_token: "x" })),
  ).toThrow("Invalid Claude auth bundle");
  expect(() => claudeSubscriptionToken("not json")).toThrow();
});

test("a token counts as complete only once its line has ended", () => {
  expect(claudeOAuthTokenLine(`token:\n${token}`, "")).toBeUndefined();
  expect(
    claudeOAuthTokenLine(`token:\n${token.slice(0, 40)}`, ""),
  ).toBeUndefined();
  expect(claudeOAuthTokenLine(`token:\n${token}  \nStore it.`, "")).toBe(token);
});

test("a token the submitted code could have formed is never taken", () => {
  // Echoed or redrawn input, whole or in part.
  expect(claudeOAuthTokenLine(`> ${token}\n`, token)).toBeUndefined();
  expect(claudeOAuthTokenLine(`> ${token}\n`, token.slice(12))).toBeUndefined();
  expect(
    claudeOAuthTokenFromOutput(`> ${token}`, `${token}#state`),
  ).toBeUndefined();
  // Claude's own token after the echoed code is still found.
  expect(claudeOAuthTokenLine(`> code#1\n${token}\n`, "code#1")).toBe(token);
  expect(
    claudeOAuthTokenLine(`> ${token.slice(0, 30)}x\n${token}\n`, "zzzz"),
  ).toBe(token);
});

test("tokens and keys are not sign-in codes", () => {
  expect(looksLikeClaudeSecret(token)).toBe(true);
  expect(looksLikeClaudeSecret("SK-ANT-api03-key")).toBe(true);
  expect(looksLikeClaudeSecret("Ab3_dE-fG#state-123")).toBe(false);
});
