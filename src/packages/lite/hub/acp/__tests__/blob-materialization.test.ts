import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  acpImageAttachment,
  buildSafeBlobFilename,
  CHAT_ATTACHMENT_MAX_AGE_MS,
  extractBlobReferences,
  harnessAttachmentNote,
  openProjectBlobStorage,
  projectBlobMaterializationRoots,
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
      project: { host: "/mnt/projects/project-1", runtime: "/home/user" },
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

describe("confined project attachments", () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  const ref = {
    url: `/blobs/image.png?uuid=${uuid}`,
    uuid,
    filename: "image.png",
  };
  const relative = ".local/share/cocalc/chat-attachments";
  const open = (hostProjectRoot: string, persist = true) =>
    openProjectBlobStorage({
      hostProjectRoot,
      runtimeProjectRoot: "/home/user",
      persist,
    });
  it("removes only saved attachments older than the retention period", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-attachments-"));
    try {
      const dir = join(root, relative);
      await mkdir(dir, { recursive: true });
      const now = Date.now();
      await writeFile(join(dir, `${uuid}-old.png`), "x");
      await writeFile(join(dir, `${uuid}-new.png`), "x");
      await writeFile(join(dir, "unrelated.txt"), "keep");
      const old = (now - CHAT_ATTACHMENT_MAX_AGE_MS - 60_000) / 1000;
      await utimes(join(dir, `${uuid}-old.png`), old, old);
      await utimes(join(dir, "unrelated.txt"), old, old);
      const storage = await open(root);
      await storage.finish();
      expect((await readdir(dir)).sort()).toEqual(
        [`${uuid}-new.png`, "unrelated.txt"].sort(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([".local", ".local/share", relative])(
    "rejects a symlink at %s without touching the target",
    async (component) => {
      const root = await mkdtemp(join(tmpdir(), "chat-confinement-"));
      try {
        const project = join(root, "project");
        const outside = join(root, "outside");
        await mkdir(project);
        await mkdir(outside);
        const target = join(outside, `${uuid}-old.png`);
        await writeFile(target, "untouched");
        await utimes(target, 1, 1);
        const link = join(project, component);
        await mkdir(join(link, ".."), { recursive: true });
        await symlink(outside, link);
        await expect(open(project)).rejects.toThrow();
        expect(await readFile(target, "utf8")).toBe("untouched");
        expect(await readdir(outside)).toEqual([`${uuid}-old.png`]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("pins the directory across replacement and does not follow existing file links", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-confinement-"));
    let storage: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const project = join(root, "project");
      const outside = join(root, "outside");
      await mkdir(project);
      await mkdir(outside);
      const target = join(outside, "target");
      await writeFile(target, "untouched");
      storage = await open(project);
      const directory = join(project, relative);
      const retained = `${directory}-retained`;
      await symlink(target, join(directory, buildSafeBlobFilename(ref)));
      await rename(directory, retained);
      await symlink(outside, directory);
      expect(await storage.write(ref, Buffer.from("image"))).toBe(
        `/home/user/${relative}/${buildSafeBlobFilename(ref)}`,
      );
      expect(await readFile(target, "utf8")).toBe("untouched");
      expect(
        await readFile(join(retained, buildSafeBlobFilename(ref)), "utf8"),
      ).toBe("image");
      expect(await readdir(outside)).toEqual(["target"]);
    } finally {
      await storage?.finish();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans temporary attachments through pinned handles, not replacement directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-confinement-"));
    let storage: Awaited<ReturnType<typeof open>> | undefined;
    try {
      storage = await open(root, false);
      const runtimePath = await storage.write(ref, Buffer.from("image"));
      const directory = join(
        root,
        runtimePath.slice("/home/user/".length),
        "..",
      );
      const retained = `${directory}-retained`;
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, buildSafeBlobFilename(ref)), "untouched");
      await rename(directory, retained);
      await symlink(outside, directory);
      await storage.finish();
      expect(await readdir(retained)).toEqual([]);
      expect(
        await readFile(join(outside, buildSafeBlobFilename(ref)), "utf8"),
      ).toBe("untouched");
    } finally {
      await storage?.finish();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces an existing hard link without truncating its other name", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-hardlink-"));
    let storage: Awaited<ReturnType<typeof open>> | undefined;
    try {
      storage = await open(root);
      const target = join(root, "unrelated");
      await writeFile(target, "untouched");
      await link(target, join(root, relative, buildSafeBlobFilename(ref)));
      await storage.write(ref, Buffer.from("image"));
      expect(await readFile(target, "utf8")).toBe("untouched");
      expect(
        await readFile(
          join(root, relative, buildSafeBlobFilename(ref)),
          "utf8",
        ),
      ).toBe("image");
    } finally {
      await storage?.finish();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects untrusted blob IDs before constructing a filename", () => {
    expect(() =>
      buildSafeBlobFilename({ ...ref, uuid: "../../outside" }),
    ).toThrow(/UUID/);
  });

  it("removes a temporary directory if opening it fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-open-failure-"));
    const originalOpen = fs.open.bind(fs);
    const spy = jest.spyOn(fs, "open").mockImplementation((file, ...args) => {
      if (
        String(file).startsWith("/proc/self/fd/") &&
        String(file).includes("/cocalc-blobs-")
      ) {
        return Promise.reject(Error("injected open failure"));
      }
      return originalOpen(file, ...args);
    });
    try {
      await expect(open(root, false)).rejects.toThrow("injected open failure");
      expect(await readdir(join(root, ".local/share/cocalc/tmp"))).toEqual([]);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
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
