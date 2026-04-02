import {
  INTERNAL_SSH_CONFIG,
  SSHD_CONFIG,
  START_PROJECT_SSH,
} from "@cocalc/conat/project/runner/constants";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "path";

export async function writeStartupScripts(home: string) {
  const ssh = join(home, START_PROJECT_SSH);
  await mkdir(dirname(ssh), { recursive: true, mode: 0o700 });
  await writeFile(ssh, START_PROJECT_SSH_SERVER_SH, {
    mode: 0o700,
  });
}

// These scripts are run every time a project starts,
// so do NOT make them slow!  The should take a few milliseconds.

const START_PROJECT_SSH_SERVER_SH = `#!/usr/bin/env bash
set -ev

RUNTIME_HOME="\${COCALC_RUNTIME_HOME:-${DEFAULT_PROJECT_RUNTIME_HOME}}"
RUNTIME_SSH_DIR="$RUNTIME_HOME/.ssh"
RUNTIME_MANAGED_SSH_DIR="$RUNTIME_HOME/${INTERNAL_SSH_CONFIG}"
RUNTIME_SSHD_DIR="$RUNTIME_HOME/${SSHD_CONFIG}"

mkdir -p /etc/dropbear
mkdir -p "$RUNTIME_SSH_DIR" "$RUNTIME_MANAGED_SSH_DIR" "$RUNTIME_SSHD_DIR"

chmod 700 "$RUNTIME_SSH_DIR" "$RUNTIME_MANAGED_SSH_DIR" "$RUNTIME_SSHD_DIR"
chmod og-rwx -R "$RUNTIME_SSH_DIR"

dropbear -p \${COCALC_SSHD_PORT:=22} -e -s -a -R -D "$RUNTIME_SSHD_DIR"

SFTP_SERVER="$(command -v sftp-server || true)"
if [ -n "$SFTP_SERVER" ]; then
  ln -sf "$SFTP_SERVER" /usr/libexec/sftp-server
fi
`;
