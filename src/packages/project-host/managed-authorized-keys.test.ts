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
import { INTERNAL_SSH_CONFIG } from "@cocalc/conat/project/runner/constants";
import { writeManagedAuthorizedKeysFile } from "./managed-authorized-keys";

describe("managed authorized_keys file", () => {
  let home: string;
  let outside: string;
  let managed: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "managed-keys-"));
    // Stands in for a host directory such as the service account's ~/.ssh.
    outside = await mkdtemp(join(tmpdir(), "managed-keys-outside-"));
    managed = join(home, INTERNAL_SSH_CONFIG, "authorized_keys");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("writes the key list with a trailing newline and private mode", async () => {
    await writeManagedAuthorizedKeysFile(home, "ssh-ed25519 AAAA one");
    expect(await readFile(managed, "utf8")).toBe("ssh-ed25519 AAAA one\n");
    expect((await stat(managed)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, INTERNAL_SSH_CONFIG))).mode & 0o777).toBe(
      0o700,
    );
  });

  it("empties the file when the last key is removed", async () => {
    await writeManagedAuthorizedKeysFile(home, "ssh-ed25519 AAAA one");
    await writeManagedAuthorizedKeysFile(home, "");
    expect(await readFile(managed, "utf8")).toBe("");
    await writeManagedAuthorizedKeysFile(home, "ssh-ed25519 AAAA two\n");
    await writeManagedAuthorizedKeysFile(home, undefined);
    expect(await readFile(managed, "utf8")).toBe("");
  });

  it("does not create the file for an empty list", async () => {
    await writeManagedAuthorizedKeysFile(home, "  ");
    await expect(stat(join(home, INTERNAL_SSH_CONFIG))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  describe("never writes through a symlink the project user planted", () => {
    const victim = () => join(outside, "authorized_keys");
    const original = "ssh-ed25519 HOST host-account-key\n";

    beforeEach(async () => {
      await writeFile(victim(), original, { mode: 0o644 });
    });

    const expectOutsideUnchanged = async () => {
      expect(await readFile(victim(), "utf8")).toBe(original);
      expect((await stat(victim())).mode & 0o777).toBe(0o644);
      expect((await stat(outside)).mode & 0o777).toBe(0o700);
    };

    it.each([
      ["~/.ssh", ".ssh"],
      ["~/.ssh/.cocalc", INTERNAL_SSH_CONFIG],
    ])("when %s points outside the home", async (_label, link) => {
      const parts = link.split("/");
      if (parts.length > 1) {
        await mkdir(join(home, ...parts.slice(0, -1)), { recursive: true });
      }
      // With ~/.ssh linked, the managed file would land in outside/.cocalc.
      if (link === ".ssh") await mkdir(join(outside, ".cocalc"));
      await symlink(outside, join(home, link));

      for (const keys of ["ssh-ed25519 ATTACKER key", ""]) {
        await expect(
          writeManagedAuthorizedKeysFile(home, keys),
        ).rejects.toThrow(/ELOOP/);
      }
      await expectOutsideUnchanged();
      if (link === ".ssh") {
        await expect(
          stat(join(outside, ".cocalc", "authorized_keys")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    });

    it.each([
      ["a key list", "ssh-ed25519 AAAA one", "ssh-ed25519 AAAA one\n"],
      ["an empty list", "", ""],
    ])(
      "replaces a symlinked authorized_keys with %s instead of following it",
      async (_label, keys, expected) => {
        await mkdir(join(home, INTERNAL_SSH_CONFIG), { recursive: true });
        await symlink(victim(), managed);
        await writeManagedAuthorizedKeysFile(home, keys);
        await expectOutsideUnchanged();
        expect(await readFile(managed, "utf8")).toBe(expected);
        await expect(readlink(managed)).rejects.toMatchObject({
          code: "EINVAL",
        });
      },
    );
  });
});
