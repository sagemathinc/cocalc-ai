import { handleProjectTouchRequest } from "./touch-service";

const touchProjectLastEdited = jest.fn();

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
    getLogger: factory,
  };
});

jest.mock("./last-edited", () => ({
  touchProjectLastEdited: (...args: any[]) => touchProjectLastEdited(...args),
}));

describe("project touch service", () => {
  beforeEach(() => {
    touchProjectLastEdited.mockReset();
  });

  it("routes a wildcard touch request to the project host touch queue", async () => {
    await handleProjectTouchRequest.call({
      subject: "project.11111111-1111-4111-8111-111111111111.touch.-",
    });

    expect(touchProjectLastEdited).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "browser-touch",
    );
  });

  it("rejects invalid project touch subjects", async () => {
    await expect(
      handleProjectTouchRequest.call({
        subject: "project.not-a-uuid.touch.-",
      }),
    ).rejects.toThrow("invalid project touch subject");
  });
});
