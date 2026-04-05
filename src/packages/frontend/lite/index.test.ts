const removeCookie = jest.fn();
const recreate_account_table = jest.fn();
const initSyncDoc = jest.fn();
let mockTarget = "projects";

jest.mock("js-cookie", () => ({
  remove: (...args) => removeCookie(...args),
}));

jest.mock("@cocalc/frontend/client/client", () => ({
  ACCOUNT_ID_COOKIE: "account_id",
}));

jest.mock("@cocalc/frontend/client/handle-target", () => ({
  __esModule: true,
  default: mockTarget,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: undefined,
    emit: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/account/table-bootstrap", () => ({
  recreate_account_table: (...args) => recreate_account_table(...args),
}));

jest.mock("./sync", () => ({
  init: (...args) => initSyncDoc(...args),
}));

describe("lite init", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockTarget = "projects";
  });

  it("clears the readable account cookie and recreates the account table when the client id changes", async () => {
    const { webapp_client } = await import("@cocalc/frontend/webapp-client");
    webapp_client.account_id = "stale-account";

    const setAccountState = jest.fn();
    const setProjectsState = jest.fn();
    const open_project = jest.fn(async () => {});
    const redux = {
      getActions: (name: string) => {
        if (name === "account") {
          return { setState: setAccountState };
        }
        if (name === "projects") {
          return { setState: setProjectsState, open_project };
        }
        throw Error(`unexpected actions store ${name}`);
      },
    };

    const lite = await import("./index");
    lite.init(
      redux as any,
      {
        account_id: "00000000-1000-4000-8000-000000000001",
        project_id: "00000000-1000-4000-8000-000000000000",
      } as any,
    );
    await Promise.resolve();

    expect(removeCookie).toHaveBeenCalledWith("account_id");
    expect(webapp_client.account_id).toBe(
      "00000000-1000-4000-8000-000000000001",
    );
    expect(setAccountState).toHaveBeenCalledWith({
      is_logged_in: true,
      account_id: "00000000-1000-4000-8000-000000000001",
    });
    expect(webapp_client.emit).toHaveBeenCalledWith("signed_in", {
      account_id: "00000000-1000-4000-8000-000000000001",
      hub: "lite",
    });
    expect(recreate_account_table).toHaveBeenCalledWith(redux);
    expect(setProjectsState).toHaveBeenCalledWith({
      open_projects: ["00000000-1000-4000-8000-000000000000"],
    });
    expect(open_project).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
      target: "project-home",
      switch_to: true,
      restore_session: false,
    });
    expect(lite.remote_sync).toBe(false);
  });

  it("does not recreate the account table when the client id is already correct", async () => {
    const { webapp_client } = await import("@cocalc/frontend/webapp-client");
    webapp_client.account_id = "00000000-1000-4000-8000-000000000001";

    const redux = {
      getActions: (name: string) => {
        if (name === "account") {
          return { setState: jest.fn() };
        }
        if (name === "projects") {
          return {
            setState: jest.fn(),
            open_project: jest.fn(async () => {}),
          };
        }
        throw Error(`unexpected actions store ${name}`);
      },
    };

    const lite = await import("./index");
    lite.init(
      redux as any,
      {
        account_id: "00000000-1000-4000-8000-000000000001",
        project_id: "00000000-1000-4000-8000-000000000000",
      } as any,
    );
    await Promise.resolve();

    expect(removeCookie).toHaveBeenCalledWith("account_id");
    expect(webapp_client.emit).not.toHaveBeenCalled();
    expect(recreate_account_table).not.toHaveBeenCalled();
  });

  it("keeps explicit settings routes in the foreground", async () => {
    mockTarget = "settings/vouchers";

    const open_project = jest.fn(async () => {});
    const redux = {
      getActions: (name: string) => {
        if (name === "account") {
          return { setState: jest.fn() };
        }
        if (name === "projects") {
          return {
            setState: jest.fn(),
            open_project,
          };
        }
        throw Error(`unexpected actions store ${name}`);
      },
    };

    const lite = await import("./index");
    lite.init(
      redux as any,
      {
        account_id: "00000000-1000-4000-8000-000000000001",
        project_id: "00000000-1000-4000-8000-000000000000",
      } as any,
    );

    expect(open_project).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
      target: "project-home",
      switch_to: false,
      restore_session: false,
    });
  });

  it("respects explicit project routes for the lite project", async () => {
    mockTarget = "projects/00000000-1000-4000-8000-000000000000/files/test.txt";

    const open_project = jest.fn(async () => {});
    const redux = {
      getActions: (name: string) => {
        if (name === "account") {
          return { setState: jest.fn() };
        }
        if (name === "projects") {
          return {
            setState: jest.fn(),
            open_project,
          };
        }
        throw Error(`unexpected actions store ${name}`);
      },
    };

    const lite = await import("./index");
    lite.init(
      redux as any,
      {
        account_id: "00000000-1000-4000-8000-000000000001",
        project_id: "00000000-1000-4000-8000-000000000000",
      } as any,
    );

    expect(open_project).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
      target: "files/test.txt",
      switch_to: true,
      restore_session: false,
    });
  });

  it("tracks whether lite remote sync is enabled", async () => {
    const redux = {
      getActions: (name: string) => {
        if (name === "account") {
          return { setState: jest.fn() };
        }
        if (name === "projects") {
          return {
            setState: jest.fn(),
            open_project: jest.fn(async () => {}),
          };
        }
        throw Error(`unexpected actions store ${name}`);
      },
    };

    const lite = await import("./index");
    lite.init(
      redux as any,
      {
        account_id: "00000000-1000-4000-8000-000000000001",
        project_id: "00000000-1000-4000-8000-000000000000",
        remote_sync: true,
      } as any,
    );

    expect(lite.remote_sync).toBe(true);
  });
});
