import { getServerSettings } from "@cocalc/database/settings/server-settings";

function parsePublicKeys(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n|,/g)
    .map((entry) => entry.trim())
    .filter((entry) =>
      entry.startsWith("ssh-") ||
      entry.startsWith("ecdsa-") ||
      entry.startsWith("sk-"),
    );
}

export async function getHostSshPublicKeys(): Promise<string[]> {
  const settings = await getServerSettings();
  const keys = parsePublicKeys(settings.project_hosts_ssh_public_keys);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of keys) {
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}
