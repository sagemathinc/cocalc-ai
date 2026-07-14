/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/launchpad",
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "account-1",
    conat_client: {
      hub: {
        system: {
          getRootfsCatalogEntries: jest.fn(),
          getRootfsCatalogPage: jest.fn(async () => ({
            images: [
              {
                id: "image-1",
                image: "registry.example.com/image-1",
                label: "Image 1",
              },
            ],
            version: 1,
          })),
        },
      },
      is_signed_in: () => true,
    },
  },
}));

import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  invalidateRootfsImageCache,
  loadRootfsImages,
  managedRootfsCatalogUrl,
} from "./manifest";

describe("managed RootFS catalog URL", () => {
  beforeEach(() => {
    invalidateRootfsImageCache();
    jest.clearAllMocks();
  });

  it("includes the application base path", () => {
    expect(managedRootfsCatalogUrl()).toBe("/launchpad/rootfs/catalog.json");
    expect(managedRootfsCatalogUrl("revision 1")).toBe(
      "/launchpad/rootfs/catalog.json?refresh=revision%201",
    );
  });

  it("still recognizes the base-prefixed URL as the managed RPC catalog", async () => {
    await expect(
      loadRootfsImages([managedRootfsCatalogUrl()]),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "image-1",
        image: "registry.example.com/image-1",
      }),
    ]);
    expect(
      webapp_client.conat_client.hub.system.getRootfsCatalogPage,
    ).toHaveBeenCalledWith({ limit: 200, query: undefined });
  });
});
