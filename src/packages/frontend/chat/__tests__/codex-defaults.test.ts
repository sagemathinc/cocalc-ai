/** @jest-environment jsdom */

describe("codex new chat defaults", () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock("@cocalc/frontend/lite");
    jest.dontMock("@cocalc/frontend/app-framework");
    jest.dontMock("@cocalc/frontend/account/util");
  });

  it("normalizes and saves codex new chat defaults", () => {
    const setAccountTable = jest.fn();
    jest.doMock("@cocalc/frontend/account/util", () => ({
      set_account_table: setAccountTable,
    }));
    jest.doMock("@cocalc/frontend/lite", () => ({
      lite: true,
    }));
    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: () => undefined,
      },
    }));

    const {
      saveCodexNewChatDefaults,
      getDefaultCodexNewChatDefaults,
      codexNewChatDefaultsEqual,
    } = require("../codex-defaults");

    const saved = saveCodexNewChatDefaults({
      model: "not-a-model",
      reasoning: "extra_high",
      sessionMode: "workspace-write",
    });

    expect(saved).toEqual({
      model: "gpt-5.4",
      reasoning: "extra_high",
      sessionMode: "workspace-write",
    });
    expect(
      codexNewChatDefaultsEqual(saved, getDefaultCodexNewChatDefaults()),
    ).toBe(false);
    expect(setAccountTable).toHaveBeenCalledWith({
      other_settings: {
        codex_new_chat_defaults: saved,
      },
    });
  });

  it("loads stored defaults for new thread setup", () => {
    jest.doMock("@cocalc/frontend/lite", () => ({
      lite: false,
    }));
    jest.doMock("@cocalc/frontend/account/util", () => ({
      set_account_table: jest.fn(),
    }));
    jest.doMock("@cocalc/frontend/app-framework", () => {
      const actual = jest.requireActual("@cocalc/frontend/app-framework");
      return {
        ...actual,
        redux: {
          ...actual.redux,
          getStore: (name: string) => {
            if (name === "customize") {
              return {
                get: () => false,
              };
            }
            if (name === "account") {
              return {
                getIn: (path: string[]) =>
                  path.join(".") === "other_settings.codex_new_chat_defaults"
                    ? {
                        toJS: () => ({
                          model: "gpt-5.4",
                          reasoning: "high",
                          sessionMode: "read-only",
                        }),
                      }
                    : undefined,
              };
            }
            return actual.redux.getStore?.(name);
          },
        },
      };
    });

    const { getDefaultNewThreadSetup } = require("../chatroom-thread-panel");

    expect(getDefaultNewThreadSetup()).toMatchObject({
      model: "gpt-5.4",
      codexConfig: {
        model: "gpt-5.4",
        reasoning: "high",
        sessionMode: "read-only",
      },
    });
  });

  it("maps legacy workspace-write launchpad settings to full-access and hides the option", () => {
    jest.doMock("@cocalc/frontend/lite", () => ({
      lite: false,
    }));
    jest.doMock("@cocalc/frontend/account/util", () => ({
      set_account_table: jest.fn(),
    }));
    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: (name: string) => {
          if (name === "customize") {
            return {
              get: (key: string) => key === "is_launchpad",
            };
          }
          return undefined;
        },
      },
    }));

    const {
      getCodexNewChatModeOptions,
      getDefaultCodexSessionMode,
      normalizeCodexNewChatDefaults,
    } = require("../codex-defaults");

    expect(getDefaultCodexSessionMode()).toBe("full-access");
    expect(getCodexNewChatModeOptions()).toEqual([
      { value: "read-only", label: "Read only" },
      { value: "full-access", label: "Full access" },
    ]);
    expect(
      normalizeCodexNewChatDefaults({
        model: "gpt-5.4",
        sessionMode: "workspace-write",
      }),
    ).toMatchObject({
      model: "gpt-5.4",
      sessionMode: "full-access",
    });
  });
});
