import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTERNAL_SSH_CONFIG,
  SSHD_CONFIG,
} from "@cocalc/conat/project/runner/constants";

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return { __esModule: true, default: factory, getLogger: factory };
});

import { writeSshAuthorizedKeys } from "./podman";

const PROXY = "ssh-ed25519 PROXY host-proxy";
const COLLAB = "ssh-ed25519 ATTACKER collaborator";

describe("project start ssh authorized_keys", () => {
  let home: string;
  let outside: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "start-keys-"));
    // Stands in for a host directory such as the service account's ~/.ssh.
    outside = await mkdtemp(join(tmpdir(), "start-keys-outside-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("writes the proxy, managed and dropbear key files", async () => {
    await mkdir(join(home, ".ssh"));
    await writeFile(join(home, ".ssh", "authorized_keys"), "ssh-rsa USER u\n");
    await writeSshAuthorizedKeys({
      home,
      sshProxyPublicKey: PROXY,
      authorizedKeys: COLLAB,
    });
    expect(
      await readFile(join(home, SSHD_CONFIG, "authorized_keys"), "utf8"),
    ).toContain(PROXY);
    expect(
      await readFile(
        join(home, INTERNAL_SSH_CONFIG, "authorized_keys"),
        "utf8",
      ),
    ).toBe(`${COLLAB}\n`);
    const user = await readFile(join(home, ".ssh", "authorized_keys"), "utf8");
    expect(user).toContain("ssh-rsa USER u");
    expect(user).toContain(PROXY);
  });

  it("empties the managed file when the last key is removed", async () => {
    await writeSshAuthorizedKeys({ home, authorizedKeys: COLLAB });
    await writeSshAuthorizedKeys({ home, authorizedKeys: "" });
    expect(
      await readFile(
        join(home, INTERNAL_SSH_CONFIG, "authorized_keys"),
        "utf8",
      ),
    ).toBe("");
  });

  describe("never writes through a symlink the project user planted", () => {
    const original = "ssh-ed25519 HOST host-account-key\n";

    beforeEach(async () => {
      await writeFile(join(outside, "authorized_keys"), original, {
        mode: 0o644,
      });
    });

    const expectOutsideUnchanged = async () => {
      expect(await readFile(join(outside, "authorized_keys"), "utf8")).toBe(
        original,
      );
      expect((await stat(join(outside, "authorized_keys"))).mode & 0o777).toBe(
        0o644,
      );
      expect((await stat(outside)).mode & 0o777).toBe(0o700);
    };

    it.each([".ssh", INTERNAL_SSH_CONFIG, SSHD_CONFIG])(
      "when %s points outside the home",
      async (link) => {
        const parent = join(home, link, "..");
        await mkdir(parent, { recursive: true });
        await symlink(outside, join(home, link));
        await expect(
          writeSshAuthorizedKeys({
            home,
            sshProxyPublicKey: PROXY,
            authorizedKeys: COLLAB,
          }),
        ).rejects.toThrow(/ELOOP/);
        await expectOutsideUnchanged();
        for (const sub of [".cocalc", "sshd"]) {
          await expect(stat(join(outside, sub))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      },
    );

    it("replaces symlinked key files instead of following them", async () => {
      await mkdir(join(home, SSHD_CONFIG), { recursive: true });
      for (const path of [
        join(".ssh", "authorized_keys"),
        join(INTERNAL_SSH_CONFIG, "authorized_keys"),
        join(SSHD_CONFIG, "authorized_keys"),
      ]) {
        await symlink(join(outside, "authorized_keys"), join(home, path));
      }
      await writeSshAuthorizedKeys({
        home,
        sshProxyPublicKey: PROXY,
        authorizedKeys: COLLAB,
      });
      await expectOutsideUnchanged();
      const managed = join(home, INTERNAL_SSH_CONFIG, "authorized_keys");
      expect(await readFile(managed, "utf8")).toBe(`${COLLAB}\n`);
      await expect(readlink(managed)).rejects.toMatchObject({ code: "EINVAL" });
      // The followed file's contents were not merged into ~/.ssh either.
      expect(
        await readFile(join(home, ".ssh", "authorized_keys"), "utf8"),
      ).not.toContain("host-account-key");
    });
  });
});
