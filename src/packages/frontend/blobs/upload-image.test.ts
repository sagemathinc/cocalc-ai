/** @jest-environment jsdom */

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/base",
}));

jest.mock("@cocalc/frontend/editors/slate/upload-utils", () => ({
  pastedBlobFilename: () => "pasted.png",
}));

import { uploadBlobImage } from "./upload-image";

describe("uploadBlobImage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ uuid: "11111111-1111-4111-8111-111111111111" }),
      text: async () => "",
    })) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("posts uploads to the same-origin app blob endpoint", async () => {
    const result = await uploadBlobImage({
      file: new Blob(["abc"], { type: "image/png" }),
      filename: "theme.png",
      projectId: "project-1",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/base/blobs?project_id=project-1",
      expect.objectContaining({
        credentials: "include",
        method: "POST",
      }),
    );
    expect(result).toEqual({
      filename: "theme.png",
      url: "/base/blobs/theme.png?uuid=11111111-1111-4111-8111-111111111111",
      uuid: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("falls back to the app base path when no control-plane URL is known", async () => {
    await uploadBlobImage({
      file: new Blob(["abc"], { type: "image/png" }),
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/base/blobs",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
