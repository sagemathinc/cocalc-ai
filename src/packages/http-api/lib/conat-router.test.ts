jest.mock("../pages/api/conat/hub", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../pages/api/conat/project", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../pages/api/conat/project-host-api-key", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./router", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import createConatRouter from "./conat-router";
import createApiV2Router from "./router";

describe("Conat HTTP router", () => {
  it("registers the API-key project-host exchange endpoint", () => {
    createConatRouter();
    expect(createApiV2Router).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.arrayContaining([
          expect.objectContaining({ path: "/project-host-api-key" }),
        ]),
      }),
    );
  });
});
