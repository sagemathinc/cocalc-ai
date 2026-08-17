/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const setProfileImageMock = jest.fn();
const publishAccountFeedMock = jest.fn();
const publishCollaboratorFeedMock = jest.fn();
const withAccountRehomeWriteFenceMock = jest.fn();

jest.mock("@cocalc/database/postgres/account/queries", () => ({
  set_account_profile_image_if_not_set: (...args: any[]) =>
    setProfileImageMock(...args),
}));

jest.mock("@cocalc/server/account/account-row-feed", () => ({
  publishAccountRowFeedEventsBestEffort: (...args: any[]) =>
    publishAccountFeedMock(...args),
}));

jest.mock("@cocalc/server/account/collaborator-feed", () => ({
  publishCollaboratorAccountFeedEventsBestEffort: (...args: any[]) =>
    publishCollaboratorFeedMock(...args),
}));

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  withAccountRehomeWriteFence: (...args: any[]) =>
    withAccountRehomeWriteFenceMock(...args),
}));

describe("initializeAccountProfileImage", () => {
  beforeEach(() => {
    jest.resetModules();
    setProfileImageMock.mockReset();
    publishAccountFeedMock.mockReset().mockResolvedValue(undefined);
    publishCollaboratorFeedMock.mockReset().mockResolvedValue(undefined);
    withAccountRehomeWriteFenceMock
      .mockReset()
      .mockImplementation(async ({ fn }) => await fn("fenced-db"));
  });

  it("writes behind the rehome fence and publishes account projections", async () => {
    const profile = {
      color: "blue",
      image: "https://images.example.com/ada.jpg",
    };
    setProfileImageMock.mockResolvedValue(profile);
    const { initializeAccountProfileImage } =
      await import("./initialize-profile-image");

    await expect(
      initializeAccountProfileImage({
        account_id: "11111111-1111-4111-8111-111111111111",
        image: "https://images.example.com/ada.jpg",
      }),
    ).resolves.toBe(true);

    expect(withAccountRehomeWriteFenceMock).toHaveBeenCalledWith({
      account_id: "11111111-1111-4111-8111-111111111111",
      action: "initialize account profile image",
      fn: expect.any(Function),
    });
    expect(setProfileImageMock).toHaveBeenCalledWith({
      db: "fenced-db",
      account_id: "11111111-1111-4111-8111-111111111111",
      image: "https://images.example.com/ada.jpg",
    });
    expect(publishAccountFeedMock).toHaveBeenCalledWith({
      account_id: "11111111-1111-4111-8111-111111111111",
      patch: { profile },
      reason: "user_query_set",
    });
    expect(publishCollaboratorFeedMock).toHaveBeenCalledWith({
      collaborator_account_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not publish when the account already has an avatar choice", async () => {
    setProfileImageMock.mockResolvedValue(undefined);
    const { initializeAccountProfileImage } =
      await import("./initialize-profile-image");

    await expect(
      initializeAccountProfileImage({
        account_id: "11111111-1111-4111-8111-111111111111",
        image: "https://images.example.com/ada.jpg",
      }),
    ).resolves.toBe(false);

    expect(publishAccountFeedMock).not.toHaveBeenCalled();
    expect(publishCollaboratorFeedMock).not.toHaveBeenCalled();
  });
});
