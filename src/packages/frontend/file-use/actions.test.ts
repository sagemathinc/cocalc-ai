/** @jest-environment jsdom */

const markProjectDocumentActivity = jest.fn();
const touch_project = jest.fn();
const publishDocumentPresence = jest.fn();
const getProjectStoreMock = jest.fn();

let mockLite = true;

const accountStore = {
  get_account_id: () => "00000000-0000-4000-8000-000000000001",
};

const projectsStore = {
  get: () => ({
    has: () => true,
  }),
};

const instanceRedux = {
  getStore: (name: string) => {
    if (name === "account") return accountStore;
    if (name === "projects") return projectsStore;
    return undefined;
  },
};

jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return mockLite;
  },
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectStore: (...args: any[]) => getProjectStoreMock(...args),
  },
}));

jest.mock("../app-framework", () => ({
  Actions: class {
    redux = instanceRedux;
  },
}));

jest.mock("@cocalc/conat/project/document-activity", () => ({
  markFile: (...args: any[]) => markProjectDocumentActivity(...args),
}));

jest.mock("@cocalc/frontend/document-presence/service", () => ({
  publishDocumentPresence: (...args: any[]) => publishDocumentPresence(...args),
}));

jest.mock("../webapp-client", () => ({
  webapp_client: {
    server_time: () => new Date("2026-04-15T19:00:00.000Z"),
    project_client: {
      touch_project: (...args: any[]) => touch_project(...args),
    },
    conat_client: {
      conat: jest.fn(() => ({ id: "client-1" })),
    },
  },
}));

describe("FileUseActions in lite mode", () => {
  beforeEach(() => {
    mockLite = true;
    markProjectDocumentActivity.mockReset();
    touch_project.mockReset();
    publishDocumentPresence.mockReset();
    getProjectStoreMock.mockReset();
    getProjectStoreMock.mockReturnValue({
      getIn: () => true,
    });
  });

  it("does not call document-activity when marking a file in lite mode", async () => {
    const { FileUseActions } = await import("./actions");
    const actions = new FileUseActions(undefined as any, undefined as any);

    await actions.mark_file(
      "00000000-1000-4000-8000-000000000000",
      "/home/user/test.txt",
      "open",
      0,
      false,
      new Date("2026-04-15T19:00:00.000Z"),
      true,
    );

    expect(touch_project).toHaveBeenCalledWith(
      "00000000-1000-4000-8000-000000000000",
    );
    expect(publishDocumentPresence).toHaveBeenCalledTimes(1);
    expect(markProjectDocumentActivity).not.toHaveBeenCalled();
  });
});
