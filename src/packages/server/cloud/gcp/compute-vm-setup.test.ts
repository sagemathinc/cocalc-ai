/*
 *  This file is part of CoCalc: Copyright (C) 2026, Sagemath, Inc.
 *  License: MS-RSL -- see https://github.com/sagemathinc/cocalc-ai/blob/main/LICENSE.md
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(__dirname, "compute-vm-setup.sh"), "utf8");

describe("managed compute GCP setup", () => {
  it("grants the controller permission to manage stable public addresses", () => {
    expect(script).toContain("roles/compute.publicIpAdmin");
  });

  it("opens the two documented public TCP ports", () => {
    expect(script).toContain("cocalc-compute-ssh");
    expect(script).toContain("--action=ALLOW --rules=tcp:22");
    expect(script).toContain("cocalc-compute-https");
    expect(script).toContain("--action=ALLOW --rules=tcp:443");
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
