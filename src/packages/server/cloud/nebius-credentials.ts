export type NebiusCredentials = {
  serviceAccountId: string;
  publicKeyId: string;
  privateKeyPem: string;
};

export type NebiusRegionConfigEntry = {
  nebius_credentials_json: string;
  nebius_parent_id: string;
  nebius_subnet_id: string;
};

export type NebiusRegionConfig = Record<string, NebiusRegionConfigEntry>;

export function parseNebiusCredentialsJson(raw: string): NebiusCredentials {
  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/\n/g, "").replace(/\r/g, ""));
  } catch (err: any) {
    throw new Error(
      `nebius_credentials_json is not valid JSON: ${err?.message ?? err}`,
    );
  }
  const sc = parsed?.["subject-credentials"];
  if (!sc) {
    throw new Error(
      "nebius_credentials_json missing subject-credentials block",
    );
  }
  const serviceAccountId = sc.iss ?? sc.sub;
  const publicKeyId = sc.kid;
  const privateKeyPem = sc["private-key"];
  if (!serviceAccountId) {
    throw new Error("nebius_credentials_json missing subject-credentials.iss");
  }
  if (!publicKeyId) {
    throw new Error("nebius_credentials_json missing subject-credentials.kid");
  }
  if (!privateKeyPem) {
    throw new Error(
      "nebius_credentials_json missing subject-credentials.private-key",
    );
  }
  return {
    serviceAccountId,
    publicKeyId,
    privateKeyPem,
  };
}

function normalizeRegionEntry(entry: any): NebiusRegionConfigEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const creds =
    entry.nebius_credentials_json ??
    entry.credentials_json ??
    entry.credentials ??
    entry.nebius_credentials;
  const parent =
    entry.nebius_parent_id ?? entry.parent_id ?? entry.project_id ?? entry.project;
  const subnet = entry.nebius_subnet_id ?? entry.subnet_id ?? entry.subnet;
  if (!creds || !parent || !subnet) return null;
  return {
    nebius_credentials_json: `${creds}`.trim(),
    nebius_parent_id: `${parent}`.trim(),
    nebius_subnet_id: `${subnet}`.trim(),
  };
}

export function parseNebiusRegionConfig(raw: string): NebiusRegionConfig {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(
      `nebius_region_config_json is not valid JSON: ${err?.message ?? err}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("nebius_region_config_json must be an object");
  }
  const out: NebiusRegionConfig = {};
  for (const [region, entry] of Object.entries(parsed)) {
    const normalized = normalizeRegionEntry(entry);
    if (!normalized) continue;
    out[region] = normalized;
  }
  if (!Object.keys(out).length) {
    throw new Error("nebius_region_config_json has no valid region entries");
  }
  return out;
}

export function getNebiusRegionConfigFromSettings(
  settings,
): NebiusRegionConfig | undefined {
  const raw = settings.nebius_region_config_json;
  if (!raw) return undefined;
  return parseNebiusRegionConfig(raw);
}

export function getNebiusRegionKeys(settings): string[] {
  try {
    const config = getNebiusRegionConfigFromSettings(settings);
    if (!config) return [];
    return Object.keys(config).sort();
  } catch {
    return [];
  }
}

export function getNebiusRegionConfigEntry(
  settings,
  region?: string,
): NebiusRegionConfigEntry | undefined {
  const config = getNebiusRegionConfigFromSettings(settings);
  if (!config) return undefined;
  if (region) return config[region];
  const keys = Object.keys(config).sort();
  if (!keys.length) return undefined;
  return config[keys[0]];
}

export function getNebiusCredentialsFromSettings(
  settings,
  opts?: { region?: string },
): NebiusCredentials {
  const regionEntry = getNebiusRegionConfigEntry(settings, opts?.region);
  if (regionEntry?.nebius_credentials_json) {
    return parseNebiusCredentialsJson(regionEntry.nebius_credentials_json);
  }
  const raw = settings.nebius_credentials_json;
  if (!raw) {
    throw new Error("nebius_credentials_json is not configured");
  }
  return parseNebiusCredentialsJson(raw);
}
