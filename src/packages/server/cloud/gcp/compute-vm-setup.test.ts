/*
 *  This file is part of CoCalc: Copyright (C) 2026, Sagemath, Inc.
 *  License: MS-RSL -- see https://github.com/sagemathinc/cocalc-ai/blob/main/LICENSE.md
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = readFileSync(join(__dirname, "compute-vm-setup.sh"), "utf8");

describe("managed compute GCP setup", () => {
  it("grants the controller permission to manage stable public addresses", () => {
    expect(script).toContain("roles/compute.publicIpAdmin");
  });

  it("opens SSH only to the named source ranges and HTTPS publicly", () => {
    expect(script).toContain("cocalc-compute-ssh");
    expect(script).toContain("--action=ALLOW --rules=tcp:22");
    expect(script).toContain("cocalc-compute-https");
    expect(script).toContain("--action=ALLOW --rules=tcp:443");
    const sshCommands = script.match(
      /gcloud compute firewall-rules (?:create|update) cocalc-compute-ssh[\s\S]*?--target-tags/g,
    );
    expect(sshCommands).toHaveLength(2);
    for (const command of sshCommands ?? []) {
      expect(command).toContain('--source-ranges="$SSH_SOURCE_RANGES_FLAG"');
      expect(command).not.toContain("0.0.0.0/0");
    }
  });

  describe("SSH_SOURCE_RANGES validation", () => {
    let dir: string;

    beforeEach(() => {
      // A gcloud stub that fails loudly: validation must stop the script
      // before any gcloud call.
      dir = mkdtempSync(join(tmpdir(), "compute-vm-setup-"));
      writeFileSync(
        join(dir, "gcloud"),
        "#!/bin/sh\necho GCLOUD_CALLED\nexit 99\n",
      );
      chmodSync(join(dir, "gcloud"), 0o755);
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    function run(ranges: string) {
      return spawnSync("bash", [join(__dirname, "compute-vm-setup.sh")], {
        encoding: "utf8",
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          PROJECT_ID: "compute-test",
          SSH_SOURCE_RANGES: ranges,
        },
      });
    }

    it.each([
      ["", "SSH_SOURCE_RANGES is required"],
      ["0.0.0.0/0", "/16 or narrower"],
      ["203.0.113.7/32, 10.0.0.0/8", "/16 or narrower"],
      ["203.0.113.7", "explicit CIDR"],
      ["203.0.113.7/24", "invalid"],
      ["not-an-ip/32", "invalid"],
    ])("rejects %j before any gcloud call", (ranges, message) => {
      const result = run(ranges);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).not.toContain("GCLOUD_CALLED");
    });
  });

  it("uses only mutable flags when updating existing firewall rules", () => {
    const updateCommands = script.match(
      /gcloud compute firewall-rules update[\s\S]*?(?=\n\s*(?:else|fi))/g,
    );
    expect(updateCommands).toHaveLength(3);
    for (const command of updateCommands ?? []) {
      expect(command).not.toContain("--network");
      expect(command).not.toContain("--direction");
      expect(command).not.toContain("--action");
      expect(command).toContain("--rules=");
    }
  });

  it("allows a distinct controller service account in a shared project", () => {
    expect(script).toContain("SA_NAME=${SA_NAME:-cocalc-compute-vm}");
    expect(script).toContain(
      'SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"',
    );
  });
});
