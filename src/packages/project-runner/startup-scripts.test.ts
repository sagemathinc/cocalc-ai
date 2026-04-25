import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTERNAL_SSH_CONFIG,
  SSHD_CONFIG,
  START_PROJECT_SSH,
} from "@cocalc/conat/project/runner/constants";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";
import { writeStartupScripts } from "./run/startup-scripts";

describe("writeStartupScripts", () => {
  it("writes the ssh startup script using canonical runtime ssh paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "cocalc-startup-scripts-"));

    await writeStartupScripts(home);

    const script = readFileSync(join(home, START_PROJECT_SSH), "utf8");
    expect(script).toContain(
      `RUNTIME_HOME="\${COCALC_RUNTIME_HOME:-${DEFAULT_PROJECT_RUNTIME_HOME}}"`,
    );
    expect(script).toContain(`RUNTIME_SSH_DIR="$RUNTIME_HOME/.ssh"`);
    expect(script).toContain(
      `RUNTIME_MANAGED_SSH_DIR="$RUNTIME_HOME/${INTERNAL_SSH_CONFIG}"`,
    );
    expect(script).toContain(`RUNTIME_SSHD_DIR="$RUNTIME_HOME/${SSHD_CONFIG}"`);
    expect(script).toContain(
      `mkdir -p "$RUNTIME_SSH_DIR" "$RUNTIME_MANAGED_SSH_DIR" "$RUNTIME_SSHD_DIR"`,
    );
  });

  it("probes standard distro sftp-server paths for modern scp support", async () => {
    const home = mkdtempSync(join(tmpdir(), "cocalc-startup-scripts-"));

    await writeStartupScripts(home);

    const script = readFileSync(join(home, START_PROJECT_SSH), "utf8");
    expect(script).toContain('SFTP_SERVER="$(command -v sftp-server || true)"');
    expect(script).toContain("/usr/lib/openssh/sftp-server");
    expect(script).toContain("/usr/lib/ssh/sftp-server");
    expect(script).toContain("/usr/libexec/openssh/sftp-server");
    expect(script).toContain("mkdir -p /usr/libexec");
    expect(script).toContain('ln -sf "$SFTP_SERVER" /usr/libexec/sftp-server');
  });
});
