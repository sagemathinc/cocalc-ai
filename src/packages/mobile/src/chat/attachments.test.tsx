import {
  uploadChatFile,
  uploadChatImage,
  writeProjectAttachment,
} from "./attachments";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { openProjectHost } from "../cocalc/site-session";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";

jest.mock("expo-crypto", () => ({ randomUUID: () => "attachment-id" }));
jest.mock("expo-file-system", () => ({
  File: jest.fn().mockImplementation(() => ({
    exists: true,
    size: 4,
    bytes: async () => new Uint8Array([1, 2, 3, 4]),
  })),
}));
jest.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  manipulateAsync: jest.fn(),
}));
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: jest.fn(),
}));
jest.mock("../cocalc/site-session", () => ({ openProjectHost: jest.fn() }));
jest.mock("@cocalc/chat-client/named-agents", () => ({
  resolveNamedAgentHost: jest.fn(),
}));

it("uploads images to the authenticated home bay and composes an inline image", async () => {
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    profile: {
      home_bay_url: "https://bay.example/cocalc",
      canonical_app_url: "https://example.org/cocalc",
      app_base_path: "/cocalc",
    },
    credential: { remember_me: "example-session" },
  } as any);
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ uuid: "11111111-1111-4111-8111-111111111111" }),
  });
  global.fetch = fetchMock;
  expect(
    await uploadChatImage({
      profileId: "profile",
      projectId: "project",
      asset: {
        uri: "file:///photo.png",
        name: "my [photo].png",
        mimeType: "image/png",
        size: 4,
      },
    }),
  ).toEqual({
    kind: "image",
    name: "my [photo].png",
    markdown:
      "![my \\[photo\\].png](https://example.org/cocalc/blobs/my__photo_.png?uuid=11111111-1111-4111-8111-111111111111)",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://bay.example/cocalc/blobs?project_id=project",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Cookie: expect.stringContaining("example-session"),
      }),
    }),
  );
});

it("writes files directly to the project host and links the exact project path", async () => {
  const files = { mkdir: jest.fn(), writeFile: jest.fn() };
  expect(
    await writeProjectAttachment({
      files: files as any,
      chatPath: "/home/user/.local/share/cocalc/agents/agent.chat",
      asset: { uri: "file:///report.pdf", name: "report.pdf" },
      bytes: new Uint8Array([1, 2, 3]),
    }),
  ).toEqual({
    kind: "file",
    name: "report.pdf",
    markdown:
      "[report.pdf](sandbox:/home/user/.local/share/cocalc/agents/mobile-uploads/attachment-id-report.pdf)",
  });
  expect(files.mkdir).toHaveBeenCalledWith(
    "/home/user/.local/share/cocalc/agents/mobile-uploads",
    { recursive: true },
  );
  expect(files.writeFile).toHaveBeenCalledWith(
    "/home/user/.local/share/cocalc/agents/mobile-uploads/attachment-id-report.pdf",
    Buffer.from([1, 2, 3]),
  );
  files.writeFile.mockClear();
  await expect(
    writeProjectAttachment({
      files: files as any,
      chatPath: "/home/user/agent.chat",
      asset: { uri: "file:///large", name: "large" },
      bytes: new Uint8Array(20_000_001),
    }),
  ).rejects.toThrow("smaller than 20 MB");
  expect(files.writeFile).not.toHaveBeenCalled();
});

it("routes file bytes to the selected project's host", async () => {
  const files = { mkdir: jest.fn(), writeFile: jest.fn() };
  const call = jest.fn().mockReturnValue(files);
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    profile: { account_id: "account" },
    hubApi: {},
  } as any);
  jest.mocked(resolveNamedAgentHost).mockResolvedValue("owner-host");
  jest.mocked(openProjectHost).mockResolvedValue({ client: { call } } as any);
  await uploadChatFile({
    profileId: "profile",
    projectId: "project",
    chatPath: "/home/user/agent.chat",
    asset: { uri: "file:///report.pdf", name: "report.pdf" },
  });
  expect(resolveNamedAgentHost).toHaveBeenCalledWith({}, "account", "project");
  expect(openProjectHost).toHaveBeenCalledWith(expect.anything(), {
    project_id: "project",
    host_id: "owner-host",
  });
  expect(call).toHaveBeenCalledWith("fs.project-project", { timeout: 60_000 });
  expect(files.writeFile).toHaveBeenCalledWith(
    "/home/user/mobile-uploads/attachment-id-report.pdf",
    Buffer.from([1, 2, 3, 4]),
  );
});
