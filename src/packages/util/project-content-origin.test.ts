/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  hostContentLabel,
  hostContentWildcardHostname,
  normalizeContentDomain,
  projectContentHostname,
  projectContentLabel,
} from "./project-content-origin";

const project_id = "0123abcd-4567-4890-8abc-def012345678";
const host_id = "FEDCBA98-7654-4321-8EDC-BA9876543210";

describe("project content origin names", () => {
  it("normalizes the content domain setting", () => {
    expect(normalizeContentDomain("cocalcusercontent.com")).toBe("cocalcusercontent.com");
    expect(normalizeContentDomain(" https://CoCalcUserContent.com/ ")).toBe(
      "cocalcusercontent.com",
    );
    expect(normalizeContentDomain("content.example.org:443")).toBe("content.example.org");
    expect(normalizeContentDomain(".cocalcusercontent.com.")).toBe("cocalcusercontent.com");
  });

  it("treats empty or malformed settings as off", () => {
    for (const value of [undefined, null, "", "   ", "localhost", "a b.com", "*.example.com", "ex_ample.com"]) {
      expect(normalizeContentDomain(value)).toBeUndefined();
    }
  });

  it("names a project's origin and its host's wildcard consistently", () => {
    expect(projectContentLabel(project_id)).toBe("0123abcd45674890" + "8abcdef012345678");
    expect(hostContentLabel(host_id)).toBe("h-fedcba9876544321" + "8edcba9876543210");
    const host = projectContentHostname({ project_id, host_id, domain: "cocalcusercontent.com" });
    const wildcard = hostContentWildcardHostname({ host_id, domain: "cocalcusercontent.com" });
    expect(host).toBe(
      "0123abcd456748908abcdef012345678.h-fedcba98765443218edcba9876543210.cocalcusercontent.com",
    );
    expect(wildcard).toBe("*.h-fedcba98765443218edcba9876543210.cocalcusercontent.com");
    // The wildcard covers exactly one label: the project.
    expect(host.split(".").slice(1).join(".")).toBe(wildcard.split(".").slice(1).join("."));
    // Every DNS label fits the 63-character limit.
    expect(Math.max(...host.split(".").map((label) => label.length))).toBeLessThanOrEqual(63);
  });
});
