// Protocol versions describe enforcement, not the application release number.
export const FUNDING_WRITER_PROTOCOL_VERSION = 1;
export const FUNDING_ROLLOUT_CHECKS = [
  "account-holds",
  "sponsored-resources",
] as const;
export type FundingRolloutCheck = (typeof FUNDING_ROLLOUT_CHECKS)[number];

export interface FundingRolloutEvidence {
  protocol_version: number;
  enforced: boolean;
  // An identifier for the inspected database/deployment fence, never a secret.
  evidence_id: string;
  as_of: string;
  expires_at: string;
}

export interface FundingRolloutCapabilities {
  bay_id: string;
  protocol_version: number;
  checks: Record<FundingRolloutCheck, FundingRolloutEvidence | null>;
  as_of: string;
}

export interface SponsorshipAvailability {
  enabled: boolean;
  available: boolean;
  reason?: string;
}
