/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A long-lived inference token from `claude setup-token`. Unlike a home
// snapshot it has no refresh token, so controllers never rotate or write back
// credentials and any number of them can share it.

const TOKEN = /^sk-ant-oat[A-Za-z0-9_-]{20,1000}$/;

/** Find the token in setup-token's (terminal) output; undefined if absent. */
export function claudeOAuthTokenFromOutput(output: string): string | undefined {
  const matches = output.match(/sk-ant-oat[A-Za-z0-9_-]{20,1000}/g);
  const token = matches?.at(-1);
  return token && TOKEN.test(token) ? token : undefined;
}

export function packClaudeSubscriptionToken(token: string): string {
  if (!TOKEN.test(token)) throw Error("Invalid Claude token");
  return JSON.stringify({ version: 2, oauth_token: token });
}

/** The token of a token payload; undefined for a home snapshot (version 1). */
export function claudeSubscriptionToken(payload: string): string | undefined {
  let value: any;
  try {
    value = JSON.parse(payload);
  } catch {
    throw Error("Invalid Claude auth bundle");
  }
  if (value?.version !== 2) return;
  if (typeof value.oauth_token !== "string" || !TOKEN.test(value.oauth_token))
    throw Error("Invalid Claude auth bundle");
  return value.oauth_token;
}
