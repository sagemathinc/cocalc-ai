/** @jest-environment jsdom */

import { DEFAULT_SITE_FUNDED_CODEX_POLICY } from "@cocalc/util/ai/site-funded-codex";
import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import { applyEffectiveCodexPolicyToAgentSession } from "./agent-session-selector";

const SESSION: AgentSessionRecord = {
  session_id: "session-1",
  project_id: "project-1",
  account_id: "account-1",
  chat_path: "/home/user/agent.chat",
  thread_key: "thread-1",
  title: "Agent",
  created_at: "2026-08-09T00:00:00.000Z",
  updated_at: "2026-08-09T00:00:00.000Z",
  status: "active",
  entrypoint: "global",
  model: "gpt-5.4-mini",
  reasoning: "low",
};

const MEMBERSHIP_PAYMENT_SOURCE = {
  source: "site-api-key" as const,
  hasSubscription: false,
  hasProjectApiKey: false,
  hasAccountApiKey: false,
  hasSiteApiKey: true,
  siteFundedCodex: {
    enabled: true,
    policy: DEFAULT_SITE_FUNDED_CODEX_POLICY,
  },
  sharedHomeMode: "disabled" as const,
};

describe("applyEffectiveCodexPolicyToAgentSession", () => {
  it("shows the effective membership-funded model instead of stale metadata", () => {
    expect(
      applyEffectiveCodexPolicyToAgentSession(
        SESSION,
        MEMBERSHIP_PAYMENT_SOURCE,
      ),
    ).toMatchObject({
      model: DEFAULT_SITE_FUNDED_CODEX_POLICY.model,
      reasoning: "medium",
      serviceTier: "standard",
    });
  });

  it("preserves sessions explicitly funded by a personal subscription", () => {
    expect(
      applyEffectiveCodexPolicyToAgentSession(
        { ...SESSION, paymentSource: "subscription" },
        MEMBERSHIP_PAYMENT_SOURCE,
      ),
    ).toEqual({ ...SESSION, paymentSource: "subscription" });
  });
});
