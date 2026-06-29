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
        null,
        false,
        null,
        "10.1.2.3",
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
        null,
        false,
        null,
        null,
      ],
    );
  });
});
