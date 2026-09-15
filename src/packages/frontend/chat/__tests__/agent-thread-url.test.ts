import { agentThreadUrl, parseAgentThreadUrl } from "../agent-thread-url";

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));
const project = "1ce4fe78-19c7-40a8-a598-947975744cd9";
const origin = "https://lite1b.cocalc.ai";
test("thread URL round trips absolute paths and exact thread identity", () => {
  const url = agentThreadUrl(
    project,
    "/home/user/a space.chat",
    "thread & one",
    origin,
  );
  expect(url).toBe(
    `${origin}/projects/${project}/files/home/user/a%20space.chat#thread=thread%20%26%20one`,
  );
  expect(parseAgentThreadUrl(url, origin)).toEqual({
    project_id: project,
    path: "/home/user/a space.chat",
    thread_id: "thread & one",
  });
});
test.each(["", "/projects", "/base/projects", "/base"])(
  "accepts copied file addresses with prefix %s",
  (prefix) => {
    expect(
      parseAgentThreadUrl(
        `${origin}${prefix}/${project}/files/home/user/B.chat#thread=a903ef26-f814-4b06-8caf-fe5714451557`,
        origin,
      ),
    ).toEqual({
      project_id: project,
      path: "/home/user/B.chat",
      thread_id: "a903ef26-f814-4b06-8caf-fe5714451557",
    });
  },
);
test("permalinks preserve deployment base paths and encode authored filenames", () => {
  const base = jest.requireMock("@cocalc/frontend/customize/app-base-path");
  base.appBasePath = "/base/";
  try {
    const url = agentThreadUrl(project, "/home/user/a #?%.chat", "a", origin);
    expect(new URL(url).pathname).toBe(
      `/base/projects/${project}/files/home/user/a%20%23%3F%25.chat`,
    );
    expect(parseAgentThreadUrl(url, origin).path).toBe("/home/user/a #?%.chat");
  } finally {
    base.appBasePath = "/";
  }
});
test("rejects cross-site, secret-bearing, threadless and non-chat URLs", () => {
  for (const url of [
    `https://elsewhere.test/projects/${project}/files/a.chat#thread=a`,
    `https://user:secret@lite1b.cocalc.ai/projects/${project}/files/a.chat#thread=a`,
    `${origin}/projects/${project}/files/a.chat`,
    `${origin}/projects/${project}/files/a.txt#thread=a`,
    `${origin}/projects/not-a-uuid/files/a.chat#thread=a`,
  ])
    expect(() => parseAgentThreadUrl(url, origin)).toThrow();
});
