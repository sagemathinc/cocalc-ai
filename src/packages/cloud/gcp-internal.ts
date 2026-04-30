export function gcpInternalHostname({
  instanceName,
  projectId,
  configuredHostname,
}: {
  instanceName?: string | null;
  projectId?: string | null;
  configuredHostname?: string | null;
}): string | undefined {
  const explicit = `${configuredHostname ?? ""}`.trim().replace(/\.$/, "");
  if (explicit) {
    return explicit.toLowerCase();
  }
  const name = `${instanceName ?? ""}`.trim().toLowerCase();
  const project = `${projectId ?? ""}`.trim().toLowerCase();
  if (!name || !project) return;
  return `${name}.c.${project}.internal`;
}
