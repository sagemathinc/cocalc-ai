import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acpImageAttachment,
  CHAT_ATTACHMENT_MAX_AGE_MS,
  extractBlobReferences,
  harnessAttachmentNote,
  projectBlobMaterializationRoots,
  pruneChatAttachments,
  rewriteBlobReferencesInPrompt,
} from "../blob-materialization";
import { ACP_MAX_IMAGE_BYTES } from "@cocalc/util/ai/harness-limits";

describe("acpImageAttachment", () => {
  it("accepts exactly 5 MiB and rejects one byte over with a valid image signature", () => {
    const png = Buffer.alloc(ACP_MAX_IMAGE_BYTES + 1);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    expect(
      Buffer.from(
        acpImageAttachment(png.subarray(0, ACP_MAX_IMAGE_BYTES)).data,
        "base64",
      ),
    ).toHaveLength(ACP_MAX_IMAGE_BYTES);
    expect(() => acpImageAttachment(png)).toThrow(/5 MiB/);
  });
  it("uses image bytes, not the user-controlled filename, for MIME", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    expect(acpImageAttachment(png)).toEqual({
      mimeType: "image/png",
      data: png.toString("base64"),
    });
    expect(() => acpImageAttachment(Buffer.from("not an image"))).toThrow();
    expect(() =>
      acpImageAttachment(Buffer.alloc(5 * 1024 * 1024 + 1)),
    ).toThrow();
  });
});

describe("projectBlobMaterializationRoots", () => {
  it("maps a host project mount to the path visible inside its container", () => {
    expect(
      projectBlobMaterializationRoots({
        hostProjectRoot: "/mnt/projects/project-1",
        runtimeProjectRoot: "/home/user",
      }),
    ).toEqual({
      host: "/mnt/projects/project-1/.local/share/cocalc/tmp",
      runtime: "/home/user/.local/share/cocalc/tmp",
      attachments: {
        host: "/mnt/projects/project-1/.local/share/cocalc/chat-attachments",
        runtime: "/home/user/.local/share/cocalc/chat-attachments",
      },
    });
  });
});

describe("harnessAttachmentNote", () => {
  it("lists saved project paths under the same labels as the prompt", () => {
    const ref = (uuid: string) => ({ url: `/blobs/x?uuid=${uuid}`, uuid });
    const attachments = [
      {
        ref: ref("a"),
        path: "/home/user/.local/share/cocalc/chat-attachments/a-x.png",
      },
      {
        ref: ref("b"),
        path: "/home/user/.local/share/cocalc/chat-attachments/b-y.png",
      },
    ];
    const prompt = rewriteBlobReferencesInPrompt(
      "see ![](/blobs/x?uuid=a) and ![](/blobs/x?uuid=b)",
      attachments,
    );
    const note = harnessAttachmentNote(attachments);
    expect(prompt).toBe("see [Attached image 1] and [Attached image 2]");
    expect(note).toContain(
      "[Attached image 1]: /home/user/.local/share/cocalc/chat-attachments/a-x.png",
    );
    expect(note).toContain(
      "[Attached image 2]: /home/user/.local/share/cocalc/chat-attachments/b-y.png",
    );
    expect(note).toContain("kept for 14 days");
    expect(harnessAttachmentNote([])).toBe("");
  });
});

describe("pruneChatAttachments", () => {
  it("removes only saved attachments older than the retention period", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-attachments-"));
    try {
      const now = Date.now();
      await writeFile(join(dir, "old.png"), "x");
      await writeFile(join(dir, "new.png"), "x");
      const old = (now - CHAT_ATTACHMENT_MAX_AGE_MS - 60_000) / 1000;
      await utimes(join(dir, "old.png"), old, old);
      expect(await pruneChatAttachments(dir, now)).toBe(1);
      expect(await readdir(dir)).toEqual(["new.png"]);
      expect(await pruneChatAttachments(join(dir, "missing"), now)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("extractBlobReferences", () => {
  it("extracts the HTML image markup emitted by the rich chat composer", () => {
    const prompt = [
      "Can you see this UI:",
      '<img alt="" title="" src="/blobs/paste-mprbim5suah.png?uuid=13f56890-208b-4590-81c4-2605ace1b29d" style="width: 855.79px; max-width: 100%;">',
    ].join("\n\n");

    expect(extractBlobReferences(prompt)).toEqual([
      {
        url: "/blobs/paste-mprbim5suah.png?uuid=13f56890-208b-4590-81c4-2605ace1b29d",
        uuid: "13f56890-208b-4590-81c4-2605ace1b29d",
        filename: "paste-mprbim5suah.png",
      },
    ]);
  });
});

describe("rewriteBlobReferencesInPrompt", () => {
  it("replaces markdown and html blob refs with attachment placeholders", () => {
    const prompt = [
      "Turn this into code:",
      "",
      "![scan](/blobs/paste-a?uuid=11111111-1111-4111-8111-111111111111)",
      "",
      '<img src="/blobs/paste-b.png?uuid=22222222-2222-4222-8222-222222222222" width="100" />',
    ].join("\n");
    const rewritten = rewriteBlobReferencesInPrompt(prompt, [
      {
        ref: {
          url: "/blobs/paste-a?uuid=11111111-1111-4111-8111-111111111111",
          uuid: "11111111-1111-4111-8111-111111111111",
        },
        path: "/tmp/a.png",
      },
      {
        ref: {
          url: "/blobs/paste-b.png?uuid=22222222-2222-4222-8222-222222222222",
          uuid: "22222222-2222-4222-8222-222222222222",
        },
        path: "/tmp/b.png",
      },
    ]);

    expect(rewritten).toContain("[Attached image 1]");
    expect(rewritten).toContain("[Attached image 2]");
    expect(rewritten).not.toContain("/blobs/");
    expect(rewritten).not.toContain("<img");
    expect(rewritten).not.toContain("![scan]");
  });
});
