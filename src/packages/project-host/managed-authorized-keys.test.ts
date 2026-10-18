import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTERNAL_SSH_CONFIG } from "@cocalc/conat/project/runner/constants";
import { writeManagedAuthorizedKeysFile } from "./managed-authorized-keys";

describe("managed authorized_keys file", () => {
  let home: string;
  let managed: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "managed-keys-"));
    managed = join(home, INTERNAL_SSH_CONFIG, "authorized_keys");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes the key list with a trailing newline and private mode", async () => {
    await writeManagedAuthorizedKeysFile(home, "ssh-ed25519 AAAA one");
    expect(await readFile(managed, "utf8")).toBe("ssh-ed25519 AAAA one\n");
    expect((await stat(managed)).mode & 0o777).toBe(0o600);
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
});
