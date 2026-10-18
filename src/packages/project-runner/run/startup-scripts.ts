import {
  INTERNAL_SSH_CONFIG,
  SSHD_CONFIG,
  START_PROJECT_SSH,
} from "@cocalc/conat/project/runner/constants";
import {
  PROJECT_STARTUP_SCRIPT_PATH,
  PROJECT_STARTUP_SCRIPT_TEMPLATE,
} from "@cocalc/util/project-startup-script";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";
import { isAbsolute, join, relative } from "node:path";
import { writeFileBeneathHome } from "@cocalc/backend/files/beneath-home";
import { hostPathForProjectPath } from "./project-path";

// Both files are under the project user's home, so they are written through
// beneath-home: a symlinked parent fails the write instead of redirecting it
// to a host directory or another project.
export async function writeStartupScripts(home: string) {
  writeFileBeneathHome(home, START_PROJECT_SSH, START_PROJECT_SSH_SERVER_SH, {
    mode: 0o700,
    dirMode: 0o700,
    chmodDir: false,
  });

  const startup = relative(
    home,
    hostPathForProjectPath(home, join(home, PROJECT_STARTUP_SCRIPT_PATH)),
  );
  if (startup.startsWith("..") || isAbsolute(startup)) return;
  // Created once; the user may edit or remove its contents afterwards.
  writeFileBeneathHome(home, startup, PROJECT_STARTUP_SCRIPT_TEMPLATE, {
    mode: 0o700,
    dirMode: 0o700,
    chmodDir: false,
    noReplace: true,
  });
}

// These scripts are run every time a project starts,
// so do NOT make them slow! They should take a few milliseconds.

const START_PROJECT_SSH_SERVER_SH = `#!/usr/bin/env bash
set -ev

RUNTIME_HOME="\${COCALC_RUNTIME_HOME:-${DEFAULT_PROJECT_RUNTIME_HOME}}"
RUNTIME_SSH_DIR="$RUNTIME_HOME/.ssh"
RUNTIME_MANAGED_SSH_DIR="$RUNTIME_HOME/${INTERNAL_SSH_CONFIG}"
RUNTIME_SSHD_DIR="$RUNTIME_HOME/${SSHD_CONFIG}"

if [ "$(id -u)" != "0" ]; then
  echo "project ssh startup must run as root" >&2
  exit 1
fi

mkdir -p /etc/dropbear
mkdir -p "$RUNTIME_SSH_DIR" "$RUNTIME_MANAGED_SSH_DIR" "$RUNTIME_SSHD_DIR"

chmod 700 "$RUNTIME_SSH_DIR" "$RUNTIME_MANAGED_SSH_DIR" "$RUNTIME_SSHD_DIR"
chmod og-rwx -R "$RUNTIME_SSH_DIR"

DROPBEAR="$(command -v dropbear || true)"
if [ -z "$DROPBEAR" ] && [ -x /opt/cocalc/bin2/dropbear ]; then
  DROPBEAR=/opt/cocalc/bin2/dropbear
fi
if [ -z "$DROPBEAR" ]; then
  echo "dropbear not found" >&2
  exit 1
fi

"$DROPBEAR" -p \${COCALC_SSHD_PORT:=22} -e -s -a -R -W 2097152

SFTP_SERVER="$(command -v sftp-server || true)"
if [ -z "$SFTP_SERVER" ]; then
  for candidate in \
    /usr/lib/openssh/sftp-server \
    /usr/lib/ssh/sftp-server \
    /usr/libexec/openssh/sftp-server
  do
    if [ -x "$candidate" ]; then
      SFTP_SERVER="$candidate"
      break
    fi
  done
fi
if [ -n "$SFTP_SERVER" ]; then
  mkdir -p /usr/libexec
  ln -sf "$SFTP_SERVER" /usr/libexec/sftp-server
fi
`;
