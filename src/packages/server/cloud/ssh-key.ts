import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { secrets } from "@cocalc/backend/data";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

const execFileAsync = promisify(execFile);

function sanitizeBayIdForPath(bayId: string): string {
  return bayId.replace(/[^A-Za-z0-9_.-]/g, "_") || "bay";
}

function hostOwnerBaySshKeyBasePath(): string {
  const configured =
    `${process.env.COCALC_HOST_OWNER_SSH_PRIVATE_KEY_PATH ?? ""}`.trim();
  if (configured) {
    return configured;
  }
  return join(
    secrets,
    "host-owner-ssh",
    sanitizeBayIdForPath(getConfiguredBayId()),
    "id_ed25519",
  );
}

function hostOwnerBaySshPublicKeyPath(privateKeyPath: string): string {
  const configured =
    `${process.env.COCALC_HOST_OWNER_SSH_PUBLIC_KEY_PATH ?? ""}`.trim();
  return configured || `${privateKeyPath}.pub`;
}

async function ensureHostOwnerBaySshKeypair(): Promise<{
  privateKeyPath: string;
  publicKeyPath: string;
}> {
  const privateKeyPath = hostOwnerBaySshKeyBasePath();
  const publicKeyPath = hostOwnerBaySshPublicKeyPath(privateKeyPath);
  await mkdir(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  if (!existsSync(privateKeyPath)) {
    await execFileAsync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      `cocalc-host-owner-bay:${getConfiguredBayId()}`,
      "-f",
      privateKeyPath,
    ]);
  }
  await chmod(privateKeyPath, 0o600);
  if (!existsSync(publicKeyPath)) {
    const { stdout } = await execFileAsync("ssh-keygen", [
      "-y",
      "-f",
      privateKeyPath,
    ]);
    await mkdir(dirname(publicKeyPath), { recursive: true, mode: 0o700 });
    await writePublicKey(publicKeyPath, `${stdout}`.trim());
  }
  await chmod(publicKeyPath, 0o644);
  return { privateKeyPath, publicKeyPath };
}

async function writePublicKey(path: string, publicKey: string): Promise<void> {
  await writeFile(path, `${publicKey.trim()}\n`, { mode: 0o644 });
}

export async function getHostOwnerBaySshIdentity(): Promise<{
  privateKeyPath: string;
  publicKey: string;
}> {
  const { privateKeyPath, publicKeyPath } =
    await ensureHostOwnerBaySshKeypair();
  const publicKey = `${await readFile(publicKeyPath, "utf8")}`.trim();
  if (!publicKey) {
    throw new Error(`empty host owner bay SSH public key: ${publicKeyPath}`);
  }
  return { privateKeyPath, publicKey };
}

function parsePublicKeys(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n|,/g)
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry.startsWith("ssh-") ||
        entry.startsWith("ecdsa-") ||
        entry.startsWith("sk-"),
    );
}

export async function getHostSshPublicKeys(): Promise<string[]> {
  const settings = await getServerSettings();
  const ownerBayIdentity = await getHostOwnerBaySshIdentity();
  const keys = [
    ownerBayIdentity.publicKey,
    ...parsePublicKeys(settings.project_hosts_ssh_public_keys),
  ];
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
