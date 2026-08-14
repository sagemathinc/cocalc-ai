/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { resolveManagedVmCreateSshAuthorization } from "./ssh-authorization";

const PROJECT_KEY = "ssh-ed25519 AAAAPROJECT project@example.com";
const OTHER_KEY = "ssh-ed25519 AAAAOTHER other@example.com";

describe("managed VM create SSH authorization", () => {
  it("defaults an omitted key to the attached project deploy key", () => {
    expect(
      resolveManagedVmCreateSshAuthorization({
        configure_project_ssh: true,
        project_key: PROJECT_KEY,
      }),
    ).toEqual({
      ssh_public_key: PROJECT_KEY,
      configure_project_ssh: true,
    });
  });

  it("can authorize the project key without maintaining an SSH alias", () => {
    expect(
      resolveManagedVmCreateSshAuthorization({
        configure_project_ssh: false,
        project_key: PROJECT_KEY,
      }),
    ).toEqual({
      ssh_public_key: PROJECT_KEY,
      configure_project_ssh: false,
    });
  });

  it("allows an explicit alternative key only without project SSH config", () => {
    expect(
      resolveManagedVmCreateSshAuthorization({
        requested_key: OTHER_KEY,
        configure_project_ssh: false,
        project_key: PROJECT_KEY,
      }),
    ).toEqual({
      ssh_public_key: OTHER_KEY,
      configure_project_ssh: false,
    });
    expect(() =>
      resolveManagedVmCreateSshAuthorization({
        requested_key: OTHER_KEY,
        configure_project_ssh: true,
        project_key: PROJECT_KEY,
      }),
    ).toThrow(/exact project deploy public key/);
  });

  it("distinguishes an explicit keyless request from an omitted key", () => {
    expect(
      resolveManagedVmCreateSshAuthorization({
        requested_key: "",
        configure_project_ssh: false,
        project_key: PROJECT_KEY,
      }),
    ).toEqual({ ssh_public_key: "", configure_project_ssh: false });
  });
});
