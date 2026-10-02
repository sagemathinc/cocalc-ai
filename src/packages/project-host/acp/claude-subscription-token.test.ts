import {
  claudeOAuthTokenFromOutput,
  claudeOAuthTokenLine,
  claudeSubscriptionToken,
  packClaudeSubscriptionToken,
} from "./claude-subscription-token";

const token = `sk-ant-oat01-${"a1_B-".repeat(12)}`;

test("finds the last complete token in terminal output", () => {
  expect(
    claudeOAuthTokenFromOutput(`Your OAuth token:\n${token}\nStore it.`),
  ).toBe(token);
  expect(claudeOAuthTokenFromOutput("sk-ant-oat01-short")).toBeUndefined();
  expect(claudeOAuthTokenFromOutput("no token here")).toBeUndefined();
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
  expect(claudeOAuthTokenLine(`token:\n${token}`)).toBeUndefined();
  expect(claudeOAuthTokenLine(`token:\n${token.slice(0, 40)}`)).toBeUndefined();
  expect(claudeOAuthTokenLine(`token:\n${token}  \nStore it.`)).toBe(token);
});
