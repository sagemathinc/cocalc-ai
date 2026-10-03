import { randomUUID } from "node:crypto";
import {
  authorizeAdmin,
  resolveUsernameOwner,
  usernameApi,
  usernameSeedControl,
} from "./usernames";

const actor = randomUUID();
const owner = randomUUID();
let bay = "seed";
let home = "admin-home";
const directory = jest.fn();
const localAdmin = jest.fn();
const localFresh = jest.fn();
const remoteAdmin = jest.fn();
const remoteFresh = jest.fn();
const accountClient = jest.fn();
const seedClient = jest.fn();
const get = jest.fn();
const set = jest.fn();
const release = jest.fn();
const resolve = jest.fn();
const remote = {
  getUsername: jest.fn(),
  setUsername: jest.fn(),
  releaseRedirect: jest.fn(),
  resolveOwner: jest.fn(),
};

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args) => directory(...args),
}));
jest.mock("./is-admin", () => ({
  __esModule: true,
  default: (...args) => localAdmin(...args),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args) => localFresh(...args),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (...args) => accountClient(...args),
}));
jest.mock("@cocalc/conat/inter-bay/usernames", () => ({
  createInterBayUsernamesClient: (...args) => seedClient(...args),
}));
jest.mock("./usernames-store", () => ({
  assertUsernameAuthority: () => {
    if (bay !== "seed") throw Error("seed only");
  },
  getUsernameLocal: (...args) => get(...args),
  setUsernameLocal: (...args) => set(...args),
  releaseUsernameRedirectLocal: (...args) => release(...args),
  resolveUsernameOwnerLocal: (...args) => resolve(...args),
}));

beforeEach(() => {
  jest.resetAllMocks();
  bay = "seed";
  home = "admin-home";
  directory.mockImplementation(async (account_id) => ({
    account_id,
    home_bay_id: home,
  }));
  localAdmin.mockResolvedValue(true);
  remoteAdmin.mockResolvedValue(true);
  accountClient.mockReturnValue({
    isAdmin: remoteAdmin,
    requireFreshAuth: remoteFresh,
  });
  seedClient.mockReturnValue(remote);
});

test("all attached-bay registry calls route to the seed, never local rows", async () => {
  bay = "attached";
  const getOpts = { account_id: actor, owner_account_id: owner };
  const setOpts = { account_id: actor, username: "zephyr-a" };
  const releaseOpts = {
    ...getOpts,
    username: "zephyr-old",
    reason: "cleanup",
    session_hash: "bound",
  };
  await usernameApi.getUsername(getOpts);
  await usernameApi.setUsername(setOpts);
  await usernameApi.releaseRedirect(releaseOpts);
  await resolveUsernameOwner("zephyr-a");
  expect(seedClient).toHaveBeenCalledWith("fabric", "seed");
  expect(remote.getUsername).toHaveBeenCalledWith(getOpts);
  expect(remote.setUsername).toHaveBeenCalledWith(setOpts);
  expect(remote.releaseRedirect).toHaveBeenCalledWith(releaseOpts);
  expect(remote.resolveOwner).toHaveBeenCalledWith({ owner: "zephyr-a" });
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});

test("getUsername is own by default and checks admin on the actor home for another owner", async () => {
  await usernameSeedControl.getUsername({ account_id: actor });
  expect(get).toHaveBeenCalledWith(actor);
  await usernameSeedControl.getUsername({
    account_id: actor,
    owner_account_id: actor.toUpperCase(),
  });
  expect(accountClient).not.toHaveBeenCalled();
  await usernameSeedControl.getUsername({
    account_id: actor,
    owner_account_id: owner,
  });
  expect(accountClient).toHaveBeenCalledWith({
    client: "fabric",
    dest_bay: "admin-home",
  });
  expect(remoteAdmin).toHaveBeenCalledWith({ account_id: actor });
  expect(get).toHaveBeenCalledWith(owner, { inspect: true });
  expect(localAdmin).not.toHaveBeenCalled();
  expect(remoteFresh).not.toHaveBeenCalled();
  remoteAdmin.mockResolvedValueOnce(false);
  get.mockClear();
  await expect(
    usernameSeedControl.getUsername({
      account_id: actor,
      owner_account_id: owner,
    }),
  ).rejects.toThrow("admin");
  expect(get).not.toHaveBeenCalled();
});

test("release validates admin and bound fresh auth on actor home, then forwards only explicit audit fields", async () => {
  const opts = {
    account_id: actor,
    owner_account_id: owner,
    username: "zephyr-a",
    reason: "cleanup",
    session_hash: "bound",
  };
  await usernameSeedControl.releaseRedirect(opts);
  expect(remoteFresh).toHaveBeenCalledWith({
    account_id: actor,
    session_hash: "bound",
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  expect(release).toHaveBeenCalledWith({
    account_id: actor,
    owner_account_id: owner,
    username: "zephyr-a",
    reason: "cleanup",
  });
  expect(remoteFresh.mock.invocationCallOrder[0]).toBeLessThan(
    release.mock.invocationCallOrder[0],
  );
  release.mockClear();
  await expect(
    usernameSeedControl.releaseRedirect({ ...opts, session_hash: undefined }),
  ).rejects.toMatchObject({ code: "fresh_auth_required" });
  remoteFresh.mockRejectedValueOnce(Error("stale session"));
  await expect(usernameSeedControl.releaseRedirect(opts)).rejects.toThrow(
    "stale session",
  );
  remoteAdmin.mockResolvedValueOnce(false);
  await expect(usernameSeedControl.releaseRedirect(opts)).rejects.toThrow(
    "admin",
  );
  expect(release).not.toHaveBeenCalled();
});

test("one-bay admin checks use the same local fresh-session conventions", async () => {
  home = "seed";
  await authorizeAdmin(actor, "bound", true);
  expect(localAdmin).toHaveBeenCalledWith(actor);
  expect(localFresh).toHaveBeenCalledWith({
    account_id: actor,
    session_hash: "bound",
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  expect(accountClient).not.toHaveBeenCalled();
});

test("admin authorization fails closed for unknown or banned actors", async () => {
  directory.mockResolvedValueOnce(null);
  await expect(authorizeAdmin(actor)).rejects.toThrow("unavailable");
  directory.mockResolvedValueOnce({ home_bay_id: home, banned: true });
  await expect(authorizeAdmin(actor)).rejects.toThrow("unavailable");
  expect(remoteAdmin).not.toHaveBeenCalled();
});

test.each(["seed", "admin-home"])(
  "admin inspection and release reject changed authority after checks on %s",
  async (actorHome) => {
    home = actorHome;
    for (const fresh of [false, true]) {
      for (const changed of [
        null,
        { home_bay_id: home, banned: true },
        { home_bay_id: "new-home" },
      ]) {
        directory
          .mockResolvedValueOnce({ account_id: actor, home_bay_id: home })
          .mockResolvedValueOnce(changed);
        if (fresh) {
          await expect(
            usernameSeedControl.releaseRedirect({
              account_id: actor,
              owner_account_id: owner,
              username: "zephyr-a",
              reason: "cleanup",
              session_hash: "bound",
            }),
          ).rejects.toThrow("authority changed");
        } else {
          await expect(
            usernameSeedControl.getUsername({
              account_id: actor,
              owner_account_id: owner,
            }),
          ).rejects.toThrow("authority changed");
        }
      }
    }
    expect(release).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  },
);
