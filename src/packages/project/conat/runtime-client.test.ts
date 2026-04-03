jest.mock("@cocalc/conat/client", () => ({
  getClient: jest.fn(),
}));

import { getClient } from "@cocalc/conat/client";
import { getProjectConatClient } from "./runtime-client";

const mockGetClient = jest.mocked(getClient);

describe("project runtime client helper", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns the Conat client from the project runtime state", () => {
    const conat = jest.fn().mockReturnValue({ id: "project-client" });
    mockGetClient.mockReturnValue({ conat } as any);

    expect(getProjectConatClient()).toEqual({ id: "project-client" });
    expect(conat).toHaveBeenCalledTimes(1);
  });
});
