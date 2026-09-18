import { encode, decode, DataEncoding } from "../core/codec";
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  validateAttachmentMetadata,
  validateAttachmentPayload,
  validateAttachmentLocation,
  type AgentAttachments,
  type AgentSnapshot,
} from "./attachments";

const file = { name: "report.pdf", size: 3, sha256: "a".repeat(64) };
const metadata = (): AgentAttachments => ({
  kind: "snapshots",
  files: [{ ...file }],
});
const payload = (): AgentSnapshot[] => [
  { ...file, data: Buffer.from([0, 128, 255]) },
];

test("native binary payload survives MsgPack without base64 conversion", () => {
  const original = payload();
  const decoded = decode({
    encoding: DataEncoding.MsgPack,
    data: encode({ encoding: DataEncoding.MsgPack, mesg: original }),
  });
  validateAttachmentPayload(metadata(), decoded);
  expect(decoded[0].data).toBeInstanceOf(Uint8Array);
  expect([...decoded[0].data]).toEqual([0, 128, 255]);
});

test("32 MiB total is inclusive, independent of per-file sizes", () => {
  const a = metadata();
  a.files = [
    { ...file, size: AGENT_ATTACHMENT_MAX_BYTES - 1 },
    { ...file, size: 1 },
  ];
  expect(() => validateAttachmentMetadata(a)).not.toThrow();
  a.files = [...a.files, { ...file, size: 1 }];
  expect(() => validateAttachmentMetadata(a)).toThrow("32 MiB");
});

test("file count includes empty files and bounds metadata", () => {
  const a = {
    kind: "snapshots" as const,
    files: Array.from({ length: 16 }, () => ({ ...file, size: 0 })),
  };
  validateAttachmentMetadata(a);
  a.files.push({ ...file, size: 0 });
  expect(() => validateAttachmentMetadata(a)).toThrow("16 attachments");
});

test.each(["../escape", "/absolute", "a/b", "a\\b", "a\u0000b", "..", ""])(
  "rejects unsafe display filename %s",
  (name) => {
    expect(() =>
      validateAttachmentMetadata({
        kind: "snapshots",
        files: [{ ...file, name }],
      }),
    ).toThrow();
  },
);

test.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])(
  "rejects invalid or excessive size %s",
  (size) => {
    expect(() =>
      validateAttachmentMetadata({
        kind: "snapshots",
        files: [{ ...file, size }],
      }),
    ).toThrow();
  },
);

test("payload cannot change prepared name, size, digest, count, or representation", () => {
  for (const change of [
    { name: "different" },
    { size: 2 },
    { sha256: "b".repeat(64) },
    { data: "AID/" },
    { data: [0, 128, 255] },
    { data: Buffer.alloc(4) },
    { path: "/tmp/arbitrary" },
  ])
    expect(() =>
      validateAttachmentPayload(metadata(), [
        { ...payload()[0], ...change } as any,
      ]),
    ).toThrow();
  expect(() => validateAttachmentPayload(metadata(), [])).toThrow();
});

test("same-project references are explicit live paths, never cross-project access", () => {
  const a: AgentAttachments = {
    kind: "project-files",
    files: [{ kind: "project-file", path: "/home/user/report.pdf" }],
  };
  validateAttachmentLocation(a, "project-a", "project-a");
  expect(() => validateAttachmentLocation(a, "project-a", "project-b")).toThrow(
    "cannot cross projects",
  );
  for (const path of [
    "relative",
    "/home/user/../secret",
    "/tmp/./file",
    "/tmp/line\nfile",
  ])
    expect(() =>
      validateAttachmentMetadata({
        ...a,
        files: [{ kind: "project-file", path }],
      }),
    ).toThrow();
});
