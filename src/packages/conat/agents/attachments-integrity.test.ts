import { createHash } from "node:crypto";
import { verifyAttachmentPayload } from "./attachments-integrity";

test("verify actual payload digests, not just caller-supplied digest strings", () => {
  const data = Buffer.from([0, 255, 128]);
  const file = {
    name: "data.bin",
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const metadata = { kind: "snapshots" as const, files: [file] };
  expect(() =>
    verifyAttachmentPayload(metadata, [{ ...file, data }]),
  ).not.toThrow();
  expect(() =>
    verifyAttachmentPayload(metadata, [
      { ...file, data: Buffer.from([0, 254, 128]) },
    ]),
  ).toThrow("digest");
});
