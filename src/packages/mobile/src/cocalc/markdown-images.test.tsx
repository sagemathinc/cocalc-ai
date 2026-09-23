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
  jest
    .mocked(getActiveSiteSession)
    .mockResolvedValue({
      profile: { account_id: "account" },
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
