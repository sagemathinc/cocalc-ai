jest.mock("@cocalc/server/metrics/hub_register", () => ({
  database_is_working: () => true,
}));
jest.mock("@cocalc/hub/logger", () => ({
  getLogger: () => ({ debug: jest.fn(), error: jest.fn() }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "seed",
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));
jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOriginForRequest: jest.fn(),
}));
jest.mock("@cocalc/server/blobs/config", () => ({
  resolveBlobStorageConfig: async () => ({
    activeBackend: "r2",
    r2: { publicBaseUrl: "https://blobs.example.edu" },
  }),
}));
jest.mock("@cocalc/server/blobs/public-url", () => ({
  isPublicBlobAvailable: jest.fn(),
}));
jest.mock("@cocalc/server/blobs/media", () => ({
  detectRasterImage: () => ({ contentType: "image/png" }),
}));
jest.mock("@cocalc/server/blobs/read", () => ({
  readBlobFromDatabase: jest.fn(),
}));

import init from "./blobs";
import { isPublicBlobAvailable } from "@cocalc/server/blobs/public-url";
import { readBlobFromDatabase } from "@cocalc/server/blobs/read";

const uuid = "4a91b24f-3aaf-4afa-a907-640cafc8f1d6";

test.each([true, false])(
  "legacy image URL with Worker availability %s",
  async (available) => {
    jest.mocked(isPublicBlobAvailable).mockResolvedValue(available);
    jest
      .mocked(readBlobFromDatabase)
      .mockReset()
      .mockResolvedValue(Buffer.from("image"));
    let handler: any;
    init({
      get: (_path: string, fn: any) => {
        handler = fn;
      },
    } as any);
    const res = {
      redirect: jest.fn(),
      type: jest.fn(),
      set: jest.fn(),
      send: jest.fn(),
    };
    await handler(
      { query: { uuid }, path: "/blobs/paste.png", headers: {} },
      res,
    );
    if (available) {
      expect(res.redirect).toHaveBeenCalledWith(
        302,
        `https://blobs.example.edu/${uuid}`,
      );
      expect(readBlobFromDatabase).not.toHaveBeenCalled();
    } else {
      expect(res.redirect).not.toHaveBeenCalled();
      expect(readBlobFromDatabase).toHaveBeenCalledWith(uuid);
      expect(res.send).toHaveBeenCalledWith(Buffer.from("image"));
    }
  },
);
