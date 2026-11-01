import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_SECCOMP_PROFILE_SHA256,
  projectSeccompProfilePath,
} from "./project-seccomp";

// The reviewed file's bytes. Tests may parse it; the runtime never does.
const FILE_BYTES = readFileSync(join(__dirname, "seccomp", "cocalc-project-seccomp.json"));
const profile = JSON.parse(FILE_BYTES.toString("utf8"));

type Rule = {
  names: string[];
  action: string;
  args?: { index: number; op: string; value: number; valueTwo?: number }[] | null;
  errnoRet?: number;
};

const rules = (profile as { syscalls: Rule[] }).syscalls;

describe("project seccomp profile file", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seccomp-test-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the profile once per content and reuses it", async () => {
    const dir = join(root, "profiles");
    const path = await projectSeccompProfilePath(dir);
    expect(path).toBe(
      join(dir, `cocalc-project-${PROJECT_SECCOMP_PROFILE_SHA256.slice(0, 16)}.json`),
    );
    expect((await readFile(path)).equals(FILE_BYTES)).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const before = (await stat(path)).mtimeMs;
    expect(await projectSeccompProfilePath(dir)).toBe(path);
    expect((await stat(path)).mtimeMs).toBe(before);
  });

  it("replaces a file whose content differs", async () => {
    const dir = join(root, "profiles");
    const path = await projectSeccompProfilePath(dir);
    await writeFile(path, '{"defaultAction":"SCMP_ACT_ALLOW"}');
    expect(await projectSeccompProfilePath(dir)).toBe(path);
    expect((await readFile(path)).equals(FILE_BYTES)).toBe(true);
  });

  it("names the file by the reviewed file's sha256", () => {
    const sha = createHash("sha256").update(FILE_BYTES).digest("hex");
    expect(PROJECT_SECCOMP_PROFILE_SHA256).toBe(sha);
    expect(sha).toBe("9e75b898fe261435521e9f844535232850526eea178f9d3dbbe66402a7437755");
  });

  it("keeps every 64-bit argument value exactly", async () => {
    const path = await projectSeccompProfilePath(join(root, "profiles"));
    const written = await readFile(path, "utf8");
    const lexemes = [
      ...FILE_BYTES.toString("utf8").matchAll(/"(?:value|valueTwo)": (\d+)/g),
    ].map((m) => m[1]);
    const big = lexemes.filter((x) => BigInt(x) > 2n ** 53n);
    expect(big).toContain("18446744073709551615");
    // A double can't hold them: parsing the JSON in JavaScript rounds these.
    expect(big.some((x) => BigInt(Number(x).toFixed(0)) !== BigInt(x))).toBe(true);
    for (const x of big) {
      expect(written).toContain(`": ${x}`);
    }
    expect(
      [...written.matchAll(/"(?:value|valueTwo)": (\d+)/g)].map((m) => m[1]),
    ).toEqual(lexemes);
  });

  it("refuses a directory that is a symlink", async () => {
    const real = join(root, "real");
    await mkdir(real);
    const link = join(root, "link");
    await symlink(real, link);
    await expect(projectSeccompProfilePath(link)).rejects.toThrow(
      /not this user's directory/,
    );
  });
});

describe("project seccomp profile content", () => {
  it("is derived from the hosts' base profile", () => {
    expect((profile as { comment: string }).comment).toContain(
      "cc374cf23846ce1f62f4dc807a8e2b8673c783c6f56cb475467621035d281e6c",
    );
  });

  it("never allows socket, setsockopt or socketcall unconditionally", () => {
    for (const rule of rules) {
      for (const name of ["socket", "setsockopt", "socketcall"]) {
        if (rule.names.includes(name) && rule.action === "SCMP_ACT_ALLOW") {
          expect(rule.args?.length ?? 0).toBeGreaterThan(0);
        }
      }
    }
  });

  it("refuses IP_OPTIONS and IP_RETOPTS on the low 32 bits", () => {
    const denies = rules.filter(
      (r) => r.names.includes("setsockopt") && r.action === "SCMP_ACT_ERRNO",
    );
    expect(denies.map((r) => [r.errnoRet, r.args])).toEqual(
      [4, 7].map((opt) => [
        1,
        [
          { index: 1, op: "SCMP_CMP_MASKED_EQ", value: 0xffffffff, valueTwo: 0 },
          { index: 2, op: "SCMP_CMP_MASKED_EQ", value: 0xffffffff, valueTwo: opt },
        ],
      ]),
    );
  });

  it("refuses MPTCP sockets on the low 32 bits and socketcall outright", () => {
    expect(
      rules.find(
        (r) =>
          r.names.includes("socket") &&
          r.errnoRet === 1 &&
          r.args?.[0]?.op === "SCMP_CMP_MASKED_EQ" &&
          r.args?.[0]?.value === 0xffffffff &&
          r.args?.[0]?.valueTwo === 262,
      ),
    ).toBeDefined();
    const socketcall = rules.filter((r) => r.names.includes("socketcall"));
    expect(socketcall).toHaveLength(1);
    expect(socketcall[0]).toMatchObject({ action: "SCMP_ACT_ERRNO", errnoRet: 1 });
  });

  it("filters the native ABI only: 32-bit system calls hit the bad-arch action", () => {
    for (const entry of (profile as { archMap: { subArchitectures: string[] }[] })
      .archMap) {
      expect(entry.subArchitectures).toEqual([]);
    }
  });

  it("does not allow io_uring", () => {
    for (const rule of rules) {
      if (rule.action === "SCMP_ACT_ALLOW") {
        expect(rule.names.filter((n) => n.startsWith("io_uring"))).toEqual([]);
      }
    }
  });
});
