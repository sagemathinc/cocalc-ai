export {};

let queryMock: jest.Mock;
let accountCreationActionsMock: jest.Mock;
let creationActionsDoneMock: jest.Mock;
let passwordHashMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/backend/auth/password-hash", () => ({
  __esModule: true,
  default: (...args: any[]) => passwordHashMock(...args),
}));

jest.mock("./account-creation-actions", () => ({
  __esModule: true,
  default: (...args: any[]) => accountCreationActionsMock(...args),
  creationActionsDone: (...args: any[]) => creationActionsDoneMock(...args),
}));

describe("accounts.createAccount", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rowCount: 1 }));
    accountCreationActionsMock = jest.fn(async () => undefined);
    creationActionsDoneMock = jest.fn(async () => undefined);
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
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("home_bay_id"),
      [
        "phase1-account@test.local",
        "hashed-password",
        "Phase",
        "One",
        "11111111-1111-4111-8111-111111111111",
        undefined,
        undefined,
        undefined,
        null,
        null,
        "bay-0",
      ],
    );
    expect(accountCreationActionsMock).toHaveBeenCalled();
    expect(creationActionsDoneMock).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });
});
