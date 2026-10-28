import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseEd25519PublicKey } from "./ssh-key";

// A real ed25519 public key (not a secret).
const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

function blob(parts: Buffer[]): string {
  return Buffer.concat(
    parts.flatMap((p) => {
      const n = Buffer.alloc(4);
      n.writeUInt32BE(p.length);
      return [n, p];
    }),
  ).toString("base64");
}
const TYPE = Buffer.from("ssh-ed25519");

describe("parseEd25519PublicKey", () => {
  it("returns the canonical line and the fingerprint ssh-keygen prints", () => {
    const dir = mkdtempSync(join(tmpdir(), "ssh-key-test-"));
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "c",
      "-f",
      join(dir, "k"),
    ]);
    const pub = readFileSync(join(dir, "k.pub"), "utf8").trim();
    const printed = execFileSync("ssh-keygen", ["-lf", join(dir, "k.pub")], {
      encoding: "utf8",
    }).split(" ")[1];
    const k = parseEd25519PublicKey(pub);
    expect(k.fingerprint).toBe(printed);
    expect(k.line).toBe(pub.split(" ").slice(0, 2).join(" "));
    // a comment is dropped
    expect(parseEd25519PublicKey(`${KEY} root@pod`).line).toBe(KEY);
    expect(parseEd25519PublicKey(`  ${KEY}\t`).line).toBe(KEY);
  });

  it.each([
    ["not a string", 42],
    ["empty", ""],
    ["another key type", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC"],
    ["two keys on two lines", `${KEY}\n${KEY}`],
    ["a carriage return", `${KEY}\r`],
    ["a NUL", `${KEY}\0`],
    ["too long", `${KEY} ${"x".repeat(200)}`],
    ["extra words", `${KEY} a b`],
    ["malformed base64", "ssh-ed25519 AAAA$$$$"],
    ["base64 of the wrong length", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5A"],
    // A valid blob is 51 bytes (68 base64 chars, no padding), so any padding
    // is non-canonical.
    ["padding where none belongs", `${KEY}==`],
    ["padding inside the base64", "ssh-ed25519 AAAA=AAA"],
    [
      "a wrong type inside the blob",
      `ssh-ed25519 ${blob([Buffer.from("ssh-ed448"), Buffer.alloc(32)])}`,
    ],
    ["a 31-byte key", `ssh-ed25519 ${blob([TYPE, Buffer.alloc(31)])}`],
    ["a 33-byte key", `ssh-ed25519 ${blob([TYPE, Buffer.alloc(33)])}`],
    [
      "trailing bytes",
      `ssh-ed25519 ${blob([TYPE, Buffer.alloc(32), Buffer.alloc(1)])}`,
    ],
    [
      "a length past the end",
      `ssh-ed25519 ${Buffer.from([0, 0, 0, 99, 1, 2]).toString("base64")}`,
    ],
    ["a type-only blob", `ssh-ed25519 ${blob([TYPE])}`],
  ])("refuses %s", (_name, input) => {
    expect(() => parseEd25519PublicKey(input)).toThrow(
      "invalid ssh-ed25519 key",
    );
  });

  it("accepts a well-formed blob it built itself", () => {
    const line = `ssh-ed25519 ${blob([TYPE, Buffer.alloc(32, 7)])}`;
    expect(parseEd25519PublicKey(line).line).toBe(line);
  });
});
