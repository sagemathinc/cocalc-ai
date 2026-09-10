/*
 *  This file is part of CoCalc: Copyright (C) 2026, Sagemath, Inc.
 *  License: MS-RSL -- see https://github.com/sagemathinc/cocalc-ai/blob/main/LICENSE.md
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(__dirname, "gcp-setup.sh"), "utf8");

describe("project-host GCP setup", () => {
  it("grants scoped Compute roles instead of project Editor", () => {
    const addBindingFunction = script.slice(
      script.indexOf("add_project_binding()"),
      script.indexOf("has_legacy_editor_binding()"),
    );
    expect(script).toContain('"roles/compute.instanceAdmin.v1"');
    expect(script).toContain('"roles/compute.securityAdmin"');
    expect(addBindingFunction).not.toContain("roles/editor");
  });

  it("removes legacy Editor only after granting replacement roles", () => {
    const grant = script.indexOf('for role in "${PROJECT_ROLES[@]}"');
    const remove = script.indexOf("Removing legacy roles/editor grant");
    expect(grant).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(grant);
  });
});
