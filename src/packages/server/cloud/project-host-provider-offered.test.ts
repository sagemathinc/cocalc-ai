/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetServerSettings = jest.fn();
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => mockGetServerSettings(),
}));

import { assertProjectHostProviderOffered } from "./project-host-provider-offered";

describe("assertProjectHostProviderOffered", () => {
  beforeEach(() => {
    mockGetServerSettings.mockReset();
    mockGetServerSettings.mockResolvedValue({
      project_hosts_nebius_enabled: true,
    });
  });

  it("refuses Nebius project hosts unless the project-host setting is on", async () => {
    await expect(assertProjectHostProviderOffered("nebius")).rejects.toThrow(
      /Nebius is not offered for project hosts/,
    );
    await expect(assertProjectHostProviderOffered("NEBIUS")).rejects.toThrow(
      /not offered/,
    );
    mockGetServerSettings.mockResolvedValue({
      project_hosts_nebius_enabled: true,
      project_hosts_nebius_hosts_enabled: true,
    });
    await expect(assertProjectHostProviderOffered("nebius")).resolves.toBe(
      undefined,
    );
    // and never with Nebius itself off
    mockGetServerSettings.mockResolvedValue({
      project_hosts_nebius_enabled: false,
      project_hosts_nebius_hosts_enabled: true,
    });
    await expect(assertProjectHostProviderOffered("nebius")).rejects.toThrow(
      /not offered/,
    );
  });

  it("never blocks other providers, and doesn't read settings for them", async () => {
    for (const cloud of ["gcp", "hyperstack", "self-host", undefined, ""]) {
      await expect(assertProjectHostProviderOffered(cloud)).resolves.toBe(
        undefined,
      );
    }
    expect(mockGetServerSettings).not.toHaveBeenCalled();
  });
});
