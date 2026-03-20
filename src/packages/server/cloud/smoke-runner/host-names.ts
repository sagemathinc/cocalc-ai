const HOST_NAME_MAX_LEN = 63;

function normalizeHostNamePart(value: string, fallback: string): string {
  const cleaned = `${value}`.trim().replace(/[^A-Za-z0-9-]/g, "-");
  const collapsed = cleaned.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return collapsed || fallback;
}

export function withSmokeHostRoleSuffix(base: string, role: string): string {
  const normalizedRole = normalizeHostNamePart(role, "host");
  const suffix = `-${normalizedRole}`;
  const maxHeadLen = Math.max(1, HOST_NAME_MAX_LEN - suffix.length);
  let head = normalizeHostNamePart(base, "host")
    .slice(0, maxHeadLen)
    .replace(/-+$/g, "");
  if (!head) {
    head = "h".slice(0, maxHeadLen);
  }
  return `${head}${suffix}`;
}

export function buildMoveSmokeHostNames(base: string): {
  sourceHostName: string;
  destHostName: string;
} {
  return {
    sourceHostName: withSmokeHostRoleSuffix(base, "src"),
    destHostName: withSmokeHostRoleSuffix(base, "dst"),
  };
}
