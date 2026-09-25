import { createHash } from "node:crypto";
import { canonicalFundingTerms as stableStringify } from "./approvals";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  getNebiusRegionConfigFromSettings,
  parseNebiusCredentialsJson,
} from "@cocalc/server/cloud/nebius-credentials";
import { normalizeCloudflareHostname } from "@cocalc/server/cloud/derived-domains";
import { FUNDING_WRITER_PROTOCOL_VERSION } from "@cocalc/util/compute-funding-rollout";
import { computeDeploymentNamespace } from "../resource-names";
import { getComputeVmConfig } from "../config";
import type {
  FundingRolloutManifest,
  FundingRolloutBay,
  FundingResourceCredential,
} from "./production-rollout-contract";

/** Public credential identities only. Cloudflare opaque tokens are bound by a
 * one-way digest, never included in a response, manifest or log as plaintext.
 */
export async function configuredFundingResourceCredentials(): Promise<
  FundingResourceCredential[]
> {
  const config = await getComputeVmConfig();
  const settings = await getServerSettings();
  const result: FundingResourceCredential[] = [];
  if (config.gcp_service_account_json) {
    const account = JSON.parse(config.gcp_service_account_json);
    if (
      !config.gcp_project_id ||
      !account.client_email ||
      !account.private_key_id
    )
      throw Error("GCP funding credential identity is incomplete.");
    result.push({
      provider: "gcp",
      scope: config.gcp_project_id,
      identity: account.client_email,
      key_id: account.private_key_id,
    });
  }
  const regions = getNebiusRegionConfigFromSettings(settings);
  for (const [region, entry] of Object.entries(regions ?? {})) {
    const credential = parseNebiusCredentialsJson(
      entry.nebius_credentials_json,
    );
    result.push({
      provider: "nebius",
      scope: `${region}/${entry.nebius_parent_id}`,
      identity: credential.serviceAccountId,
      key_id: credential.publicKeyId,
    });
  }
  const token = settings.project_hosts_cloudflare_tunnel_api_token;
  if (token) {
    const hostname = normalizeCloudflareHostname(settings.dns);
    if (!hostname) throw Error("DNS funding credential scope is incomplete.");
    result.push({
      provider: "cloudflare",
      scope: hostname,
      identity: hostname,
      key_id: `sha256:${createHash("sha256").update(token).digest("hex")}`,
    });
  }
  return result;
}

/** Deployment signature attests the retired cloud keys and old queue workers
 * were removed. We additionally check the actual configured identities and
 * compiled protocol; we do not claim to have queried provider IAM revocation.
 */
export async function verifySponsoredResourceWriters(
  manifest: FundingRolloutManifest,
  bay: FundingRolloutBay,
): Promise<void> {
  const { SPONSORED_RESOURCE_WRITER_PROTOCOL_VERSION } =
    await import("../worker");
  if (
    SPONSORED_RESOURCE_WRITER_PROTOCOL_VERSION !==
      FUNDING_WRITER_PROTOCOL_VERSION ||
    manifest.deployment_id !== process.env.COCALC_COMPUTE_DEPLOYMENT_ID ||
    bay.namespace !== computeDeploymentNamespace()
  )
    throw Error(
      "Sponsored resource writer protocol/deployment namespace is not attested.",
    );
  const key = (c: FundingResourceCredential) => `${c.provider}:${c.scope}`;
  const actual = (await configuredFundingResourceCredentials()).sort((a, b) =>
    key(a).localeCompare(key(b)),
  );
  const expected = [...bay.resource_credentials].sort((a, b) =>
    key(a).localeCompare(key(b)),
  );
  if (stableStringify(actual) !== stableStringify(expected))
    throw Error(
      "Configured compute/DNS credentials differ from the attested rollout.",
    );
}
