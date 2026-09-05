export {};

let queryMock: jest.Mock;
let passwordHashMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/backend/auth/password-hash", () => ({
  __esModule: true,
  default: (...args: any[]) => passwordHashMock(...args),
}));

describe("accounts.createAccount", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rowCount: 1 }));
    passwordHashMock = jest.fn(() => "hashed-password");
  });

  it.each(["system", "light", "dark"])(
    "preserves a valid explicit %s preference and unrelated settings",
    async (appearance_theme) => {
      const createAccount = (await import("./create-account")).default;
      const other_settings = { appearance_theme, locale: "de" };
      await createAccount({
        email: "appearance@test.local",
        account_id: "11111111-1111-4111-8111-111111111111",
        other_settings,
      });
      expect(queryMock.mock.calls[0][1][12]).toEqual(other_settings);
    },
  );

  it("does not use malformed appearance input as the new-account default", async () => {
    const createAccount = (await import("./create-account")).default;
    await createAccount({
      email: "appearance@test.local",
      account_id: "11111111-1111-4111-8111-111111111111",
      other_settings: { appearance_theme: "auto", locale: "fr" },
    });
    expect(queryMock.mock.calls[0][1][12]).toEqual({
      appearance_theme: "system",
      locale: "fr",
    });
  });

  it("stores the configured home bay on account creation", async () => {
    const createAccount = (await import("./create-account")).default;
    await createAccount({
      email: "phase1-account@test.local",
      password: "secret",
      firstName: "Phase",
      lastName: "One",
      account_id: "11111111-1111-4111-8111-111111111111",
      created_by: "10.1.2.3",
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("created_by"),
      [
        "phase1-account@test.local",
        "hashed-password",
        "Phase One",
        null,
        null,
        "11111111-1111-4111-8111-111111111111",
        undefined,
        undefined,
        undefined,
        null,
        null,
        "bay-0",
        { appearance_theme: "system" },
        false,
        null,
        "10.1.2.3",
        null,
      ],
    );
  });

  it("allows account creation to target a remote home bay", async () => {
    const createAccount = (await import("./create-account")).default;
    await createAccount({
      email: "phase1-remote@test.local",
      password: "secret",
      firstName: "Phase",
      lastName: "Remote",
      account_id: "22222222-2222-4222-8222-222222222222",
      home_bay_id: "bay-7",
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("home_bay_id"),
      [
        "phase1-remote@test.local",
        "hashed-password",
        "Phase Remote",
        null,
        null,
        "22222222-2222-4222-8222-222222222222",
        undefined,
        undefined,
        undefined,
        null,
        null,
        "bay-7",
        { appearance_theme: "system" },
        false,
        null,
        null,
        null,
      ],
    );
  });
});
