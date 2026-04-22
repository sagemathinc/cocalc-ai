const inspect = jest.fn();

jest.mock("@cocalc/backend/data", () => ({
  conatServer: "http://localhost:1234",
}));

jest.mock("@cocalc/backend/base-path", () => ({
  __esModule: true,
  default: "",
}));

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: factory,
  };
});

jest.mock("./rootfs-base", () => ({
  inspect: (...args: any[]) => inspect(...args),
}));

describe("project container environment", () => {
  beforeEach(() => {
    inspect.mockReset();
    inspect.mockResolvedValue({
      Config: {
        Env: ["PATH=/usr/bin", "LOGS=/tmp/image-logs"],
      },
    });
  });

  it("uses COCALC_LOGS instead of leaking generic LOGS into user shells", async () => {
    const { getEnvironment } = await import("./env");
    const env = await getEnvironment({
      HOME: "/home/user",
      project_id: "00000000-1000-4000-8000-000000000000",
      image: "test-image",
    });

    expect(env.COCALC_LOGS).toBe("/home/user/.cache/cocalc/project");
    expect(env.LOGS).toBeUndefined();
  });
});
