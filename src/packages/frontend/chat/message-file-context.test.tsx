/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentMessageFileContext } from "./message-file-context";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { fileURL } from "@cocalc/frontend/lib/cocalc-urls";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { EditableMarkdown } from "@cocalc/frontend/editors/slate/editable-markdown";
import {
  FrameContext,
  defaultFrameContext,
} from "@cocalc/frontend/frame-editors/frame-tree/frame-context";

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

const openFile = jest.fn();
const loadTarget = jest.fn();
const projectId = "11111111-1111-4111-8111-111111111111";
const chatPath = "/home/user/.local/share/cocalc/agents/agent.chat";

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    redux: {
      ...actual.redux,
      getProjectActions: () => ({
        open_file: openFile,
        isDirViaCache: () => false,
        isDir: async () => false,
        get_store: () => ({ get: () => undefined }),
        load_target: loadTarget,
      }),
      getActions: () => ({
        load_target: loadTarget,
        open_project: jest.fn(),
        set_active_tab: jest.fn(),
      }),
    },
  };
});

function Response({
  directory,
  value,
}: {
  directory?: string;
  value?: string;
}) {
  const location = { project_id: projectId, path: chatPath };
  return (
    <FileContext.Provider
      value={{
        ...location,
        urlTransform: getUrlTransform(location),
        AnchorTagComponent: getAnchorTagComponent(location),
      }}
    >
      <AgentMessageFileContext projectId={projectId} directory={directory}>
        <StaticMarkdown
          value={
            value ??
            "[View the PNG](sin-x-squared.png)\n\n![Plot](sin-x-squared.png)"
          }
        />
      </AgentMessageFileContext>
    </FileContext.Provider>
  );
}

beforeEach(() => jest.clearAllMocks());

test("the onboarding response opens its PNG from the turn cwd with keyboard and mouse", async () => {
  const user = userEvent.setup();
  render(<Response directory="/home/user" />);
  expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute(
    "src",
    fileURL({ project_id: projectId, path: "/home/user/sin-x-squared.png" }),
  );
  const link = screen.getByRole("link", { name: "View the PNG" });
  await user.tab();
  expect(link).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(loadTarget).toHaveBeenCalledWith(
      "files/home/user/sin-x-squared.png",
      true,
      false,
      true,
      undefined,
    ),
  );
  loadTarget.mockClear();
  await user.click(link);
  await waitFor(() =>
    expect(loadTarget).toHaveBeenCalledWith(
      "files/home/user/sin-x-squared.png",
      true,
      false,
      true,
      undefined,
    ),
  );
});

test("normal chat messages keep their existing file-relative context", async () => {
  render(<Response />);
  expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute(
    "src",
    fileURL({
      project_id: projectId,
      path: "/home/user/.local/share/cocalc/agents/sin-x-squared.png",
    }),
  );
  await userEvent.click(screen.getByRole("link", { name: "View the PNG" }));
  await waitFor(() =>
    expect(loadTarget).toHaveBeenCalledWith(
      "files/home/user/.local/share/cocalc/agents/sin-x-squared.png",
      true,
      false,
      true,
      undefined,
    ),
  );
});

test("read-only Slate activity links and images use the turn cwd even inside the hidden chat frame", async () => {
  render(
    <FrameContext.Provider
      value={{ ...defaultFrameContext, project_id: projectId, path: chatPath }}
    >
      <AgentMessageFileContext projectId={projectId} directory="/home/user">
        <EditableMarkdown
          value="[View the PNG](sin-x-squared.png)\n\n![Plot](sin-x-squared.png)"
          read_only
          enableUpload={false}
          minimal
          hidePath
          disableWindowing
          noVfill
          showEditBar={false}
          height="auto"
        />
      </AgentMessageFileContext>
    </FrameContext.Provider>,
  );
  expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute(
    "src",
    fileURL({ project_id: projectId, path: "/home/user/sin-x-squared.png" }),
  );
  await userEvent.click(screen.getByRole("link", { name: "View the PNG" }));
  await waitFor(() =>
    expect(loadTarget).toHaveBeenCalledWith(
      `${projectId}/files/home/user/sin-x-squared.png`,
      true,
      false,
      true,
      undefined,
    ),
  );
});

test("absolute files, external resources and blob URLs do not get rebased", async () => {
  render(
    <Response
      directory="/home/user/another"
      value={[
        "[Absolute](/home/user/sin-x-squared.png)",
        "[External](https://example.com/report)",
        "![Remote](https://example.com/plot.png)",
        "![Upload](/blobs/plot.png?uuid=test)",
      ].join("\n\n")}
    />,
  );
  expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
    "href",
    "https://example.com/report",
  );
  expect(screen.getByRole("img", { name: "Remote" })).toHaveAttribute(
    "src",
    "https://example.com/plot.png",
  );
  expect(screen.getByRole("img", { name: "Upload" })).toHaveAttribute(
    "src",
    "/blobs/plot.png?uuid=test",
  );
  await userEvent.click(screen.getByRole("link", { name: "Absolute" }));
  await waitFor(() =>
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/home/user/sin-x-squared.png" }),
    ),
  );
});
