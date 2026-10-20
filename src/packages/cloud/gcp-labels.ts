/*
Default labels for GCP compute instances.

Deployments can require labels on every VM they create (for example, a SOC 2
inventory tool may require `environment`, `owner`, `project`,
`dataclassification` and `application`). Set them once with

  COCALC_GCP_DEFAULT_LABELS="environment=production,owner=ops,project=cocalc"

Labels passed explicitly by the caller always win over these defaults, so
per-VM labels such as a dedicated VM's customer `owner` are never overwritten.
Invalid entries are skipped with a warning, because GCP rejects the whole
instance insert if any label is invalid.
*/

import logger from "./logger";

// https://cloud.google.com/compute/docs/labeling-resources#requirements
const LABEL_KEY = /^[a-z][a-z0-9_-]{0,62}$/;
const LABEL_VALUE = /^[a-z0-9_-]{0,63}$/;
const MAX_LABELS = 64;

export function parseDefaultGcpLabels(
  raw: string | undefined = process.env.COCALC_GCP_DEFAULT_LABELS,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
    const value = eq === -1 ? "" : trimmed.slice(eq + 1).trim();
    if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) {
      logger.warn("gcp: ignoring invalid COCALC_GCP_DEFAULT_LABELS entry", {
        entry: trimmed,
      });
      continue;
    }
    labels[key] = value;
  }
  return labels;
}

export function withDefaultGcpLabels(
  labels: Record<string, string> | undefined,
  defaults: Record<string, string> = parseDefaultGcpLabels(),
): Record<string, string> | undefined {
  const merged = { ...defaults, ...(labels ?? {}) };
  const keys = Object.keys(merged);
  if (keys.length === 0) return undefined;
  if (keys.length > MAX_LABELS) {
    throw new Error(`gcp: too many instance labels (${keys.length})`);
  }
  return merged;
}
