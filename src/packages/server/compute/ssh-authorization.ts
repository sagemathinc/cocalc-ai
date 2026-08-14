/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function normalizeManagedVmSshPublicKey(value: unknown): string {
  const key = `${value ?? ""}`.trim();
  if (!key) return "";
  if (key.includes("\n") || key.includes("\r")) {
    throw new Error("ssh_public_key must contain exactly one public key");
  }
  if (
    !/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/]+={0,3}(?:\s+[^\r\n]+)?$/.test(
      key,
    )
  ) {
    throw new Error("ssh_public_key must be an OpenSSH public key");
  }
  if (key.length > 16_384) throw new Error("ssh_public_key is too large");
  return key;
}

export function resolveManagedVmCreateSshAuthorization(opts: {
  requested_key?: string;
  configure_project_ssh?: boolean;
  project_key?: string | null;
}): { ssh_public_key: string; configure_project_ssh: boolean } {
  const projectKey = normalizeManagedVmSshPublicKey(opts.project_key);
  const requestedKey =
    opts.requested_key == null
      ? projectKey
      : normalizeManagedVmSshPublicKey(opts.requested_key);
  const configureProjectSsh = opts.configure_project_ssh === true;
  if (configureProjectSsh && (!projectKey || projectKey !== requestedKey)) {
    throw new Error(
      "automatic project SSH configuration requires the exact project deploy public key",
    );
  }
  return {
    ssh_public_key: requestedKey,
    configure_project_ssh: configureProjectSsh,
  };
}
