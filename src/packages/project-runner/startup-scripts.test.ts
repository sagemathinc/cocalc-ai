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
});
