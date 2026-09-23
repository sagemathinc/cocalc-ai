import { createMarkdownImageResolver } from "./markdown-images";
import { getActiveSiteSession } from "./session-registry";
import { openProjectHost } from "./site-session";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
jest.mock("./session-registry", () => ({ getActiveSiteSession: jest.fn() }));
jest.mock("./site-session", () => ({ openProjectHost: jest.fn() }));
jest.mock("@cocalc/chat-client/named-agents", () => ({
  resolveNamedAgentHost: jest.fn(),
}));
jest.mock("../preview/fixtures", () => ({ isPreviewProfile: () => false }));
it("loads relative images on the owning host, with bounded sizes and no external credentials", async () => {
  const files = {
    stat: jest.fn().mockResolvedValue({ size: 3 }),
    readFile: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  };
  const call = jest.fn().mockReturnValue(files);
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    profile: {
      account_id: "account",
      canonical_app_url: "https://cocalc.ai",
    },
    hubApi: {},
  } as any);
  jest.mocked(resolveNamedAgentHost).mockResolvedValue("host");
  jest.mocked(openProjectHost).mockResolvedValue({ client: { call } } as any);
  const resolve = createMarkdownImageResolver(
    "profile",
    "project",
    "/home/user/chat/conversation.chat",
  );
  expect(await resolve("../plot.png")).toEqual({
    uri: "data:image/png;base64,AQID",
  });
  expect(files.readFile).toHaveBeenCalledWith("/home/user/plot.png");
  expect(call).toHaveBeenCalledWith("fs.project-project", { timeout: 30000 });
  expect(openProjectHost).toHaveBeenCalledWith(expect.anything(), {
    project_id: "project",
    host_id: "host",
  });
  jest.mocked(openProjectHost).mockClear();
  const uuid = "2b0ef75b-c04c-4cbe-b5e6-8cfbadff4b9f";
  expect(await resolve(`/blobs/paste.png?uuid=${uuid}`)).toEqual({
    uri: `https://cocalc.ai/blobs/paste.png?uuid=${uuid}`,
  });
  expect(openProjectHost).not.toHaveBeenCalled();
  await expect(resolve("/blobs/paste.png?uuid=invalid")).rejects.toThrow(
    "Invalid blob",
  );
  await expect(resolve("file:///private/key.png")).rejects.toThrow(
    "Unsupported",
  );
  await expect(resolve("//example.com/image.png")).rejects.toThrow(
    "Unsupported",
  );
  files.stat.mockResolvedValue({ size: 10 * 1024 * 1024 });
  files.readFile.mockClear();
  await expect(resolve("big.png")).rejects.toThrow("too large");
  expect(files.readFile).not.toHaveBeenCalled();
});

it("keeps a site's app base path when displaying pasted blobs", async () => {
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    profile: { canonical_app_url: "https://example.org/cocalc" },
  } as any);
  const resolve = createMarkdownImageResolver(
    "profile",
    "project",
    "/home/user/chat.chat",
  );
  const uuid = "2b0ef75b-c04c-4cbe-b5e6-8cfbadff4b9f";
  expect(await resolve(`/blobs/paste.png?uuid=${uuid}`)).toEqual({
    uri: `https://example.org/cocalc/blobs/paste.png?uuid=${uuid}`,
  });
  expect(await resolve(`/cocalc/blobs/paste.png?uuid=${uuid}`)).toEqual({
    uri: `https://example.org/cocalc/blobs/paste.png?uuid=${uuid}`,
  });
  await expect(
    resolve(`/cocalc/blobs/../private?uuid=${uuid}`),
  ).rejects.toThrow("Invalid blob");
});
