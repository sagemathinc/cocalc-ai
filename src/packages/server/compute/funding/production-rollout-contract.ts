/** Signed by deployment tooling after the fleet and credential rollout, never by
 * an application hub. No secrets or mutable financial data belong here.
 */
export const FUNDING_ACCOUNT_WRITER_ROLES = [
  "account-holds",
  "purchase-ledger",
  "refunds",
  "membership",
  "renewals",
  "automatic-payments",
  "transfers",
  "project-admission",
] as const;
export const FUNDING_RESOURCE_WRITER_ROLES = [
  "vm-admission",
  "vm-worker",
  "volume-worker",
  "metering",
  "deadlines",
  "orphan-sweep",
  "dns",
] as const;
export type FundingWriterRole =
  | (typeof FUNDING_ACCOUNT_WRITER_ROLES)[number]
  | (typeof FUNDING_RESOURCE_WRITER_ROLES)[number];

export interface FundingRolloutWriter {
  id: string;
  build_id: string;
  protocol_version: number;
  database_role: string;
  roles: FundingWriterRole[];
}
export interface FundingCredentialRevocation {
  id: string;
  revoked_at: string;
  evidence_id: string;
}
export interface FundingResourceCredential {
  provider: "gcp" | "nebius" | "cloudflare";
  // Region/project/account scope, as returned by the configuration helper.
  scope: string;
  identity: string;
  key_id: string;
}
export interface FundingRolloutBay {
  bay_id: string;
  namespace: string;
  database: {
    system_identifier: string;
    name: string;
    writer_roles: string[];
    operator_roles: string[];
    retired_roles: FundingCredentialRevocation[];
  };
  writers: FundingRolloutWriter[];
  resource_credentials: FundingResourceCredential[];
  retired_resource_credentials: FundingCredentialRevocation[];
  credential_rollout: {
    epoch: string;
    // Bootstrap attests a fresh credential scope; rotation attests retirement.
    mode: "bootstrap" | "rotation";
    previous_epoch?: string;
    completed_at: string;
    evidence_id: string;
  };
}
export interface FundingRolloutManifest {
  kind: "cocalc-funding-rollout";
  version: 1;
  deployment_id: string;
  rollout_id: string;
  seed_bay_id: string;
  issued_at: string;
  expires_at: string;
  bays: FundingRolloutBay[];
  exposure_allocation?: {
    id: string;
    site_ceiling_usd: string;
    bay_quotas: { bay_id: string; amount_usd: string }[];
  };
}
export interface SignedFundingRolloutManifest {
  manifest: FundingRolloutManifest;
  signature: string;
}
