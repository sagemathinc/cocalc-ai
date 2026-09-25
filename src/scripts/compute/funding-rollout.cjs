#!/usr/bin/env node
/* CoCalc: Copyright (c) 2026 Sagemath, Inc. License: MS-RSL. */
const { createPrivateKey, createPublicKey, sign } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { parseArgs } = require("node:util");

// Server logging initialization must not pollute the machine-readable report.
process.env.DEBUG = "";

const HELP = `Offline funding rollout manifest utility (run from a built checkout).

  node scripts/compute/funding-rollout.cjs sign --manifest <unsigned.json> --private-key <operator.pem> --output <signed.json>
  node scripts/compute/funding-rollout.cjs verify --manifest <signed.json> --public-key <operator.pub.pem>

Signing validates the complete manifest and never overwrites an existing file.
Keep the signing private key off hub/project machines. Verification checks the
signature and contract only, not live database roles, cloud IAM, or fleet health.
Neither command connects to a hub, enables funding, or changes credentials.
`;

function run(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      manifest: { type: "string" },
      "private-key": { type: "string" },
      "public-key": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return process.stdout.write(HELP);
  const [command] = positionals;
  if (positionals.length !== 1 || !["sign", "verify"].includes(command))
    throw Error("Choose sign or verify; use --help for arguments.");
  if (!values.manifest) throw Error("--manifest is required.");
  if (
    command === "sign"
      ? !values["private-key"] || !values.output || values["public-key"]
      : !values["public-key"] || values.output || values["private-key"]
  )
    throw Error("Invalid arguments for this command; use --help.");
  const {
    verifyFundingRolloutManifest,
    fundingExposureAllocationDigest,
  } = require("../../packages/server/dist/compute/funding/production-rollout-manifest");
  const {
    canonicalFundingTerms,
  } = require("../../packages/server/dist/compute/funding/approvals");
  let raw = readFileSync(values.manifest, "utf8");
  let publicKey;
  if (command === "sign") {
    const key = createPrivateKey(readFileSync(values["private-key"]));
    if (key.asymmetricKeyType !== "ed25519")
      throw Error("An Ed25519 signing key is required.");
    const manifest = JSON.parse(raw);
    raw = JSON.stringify({
      manifest,
      signature: sign(
        null,
        Buffer.from(canonicalFundingTerms(manifest)),
        key,
      ).toString("base64"),
    });
    publicKey = createPublicKey(key).export({ type: "spki", format: "pem" });
  } else publicKey = readFileSync(values["public-key"], "utf8");
  const { manifest, digest } = verifyFundingRolloutManifest(raw, publicKey);
  if (command === "sign")
    writeFileSync(values.output, `${raw}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(
    `${JSON.stringify(
      {
        validation: "offline-signature-and-contract-only",
        deployment_id: manifest.deployment_id,
        rollout_id: manifest.rollout_id,
        expires_at: manifest.expires_at,
        bay_ids: manifest.bays.map((bay) => bay.bay_id),
        database_trust_models: Object.fromEntries(
          manifest.bays.map((bay) => [bay.bay_id, bay.database.trust_model]),
        ),
        manifest_sha256: digest,
        exposure_allocation_sha256: manifest.exposure_allocation
          ? fundingExposureAllocationDigest(manifest)
          : null,
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Funding rollout: ${err.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = { run };
