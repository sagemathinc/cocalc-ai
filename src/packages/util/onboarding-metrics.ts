// Shared by the browser and the account-home monitoring worker.
export const ONBOARDING_METRICS = {
  started: "onboarding_first_request_started",
  phase: "onboarding_first_request_phase",
  visible: "onboarding_first_output_visible",
  failed: "onboarding_first_request_failed",
  abandoned: "onboarding_first_request_abandoned",
  stalled: "onboarding_first_request_stalled",
  incomplete: "onboarding_first_request_incomplete",
} as const;

export const ONBOARDING_SLOW_MS = 10_000;
export const ONBOARDING_STALLED_MS = 60_000;
export const ONBOARDING_DEADLINE_MS = 120_000;

export const ONBOARDING_PHASES = {
  workspace: "Preparing your workspace...",
  starting: "Starting your workspace...",
  chat: "Setting up your conversation...",
  identity: "Preparing your agent...",
  ready: "Your agent is ready",
  funding: "Checking your agent settings...",
  sending: "Sending your request...",
  output: "Waiting for your agent's response...",
} as const;
export type OnboardingPhase = keyof typeof ONBOARDING_PHASES;
