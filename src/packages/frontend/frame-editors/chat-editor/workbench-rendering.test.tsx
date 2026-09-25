import { EventEmitter } from "events";
import { fromJS } from "immutable";
import { render, screen } from "@testing-library/react";
import { artifactKey, artifactPublicationKey } from "@cocalc/chat";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { Workbench } from "./workbench";

jest.mock("./actions", () => ({ focusChatFrameInput: jest.fn() }));
jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: () => null,
}));

test.each([false, true])(
  "real artifact renderer rejects inherited trust (historical=%s)",
  (historical) => {
    const target = { thread_id: "thread", artifact_id: "artifact" };
    const markdown = [
      "# A readable heading",
      '<a href="javascript:window.attack()">unsafe link</a>',
      "<script>window.attack()</script>",
      "![remote image](https://example.com/tracking.png)",
    ].join("\n\n");
    const artifact = {
      ...artifactKey(target),
      ...target,
      schema_version: 1,
      kind: "markdown",
      title: "Draft",
      input: markdown,
    };
    const publication = {
      ...artifactPublicationKey(target, "publish"),
      ...target,
      schema_version: 1,
      operation_id: "publish",
      message_id: "message",
      snapshot: { title: "Draft", markdown },
    };
    const syncdb = Object.assign(new EventEmitter(), {
      get_one: (key) =>
        key.event === "chat-artifact" ? artifact : publication,
      get: () => [publication],
    });
    const { container } = render(
      <FileContext.Provider value={{ noSanitize: true }}>
        <Workbench
          {...({
            actions: {
              getArtifactSyncdb: () => syncdb,
              getChatActions: () => ({ syncdb }),
            },
            desc: fromJS({
              "data-origin": "origin",
              "data-thread": target.thread_id,
              "data-artifact": target.artifact_id,
              "data-version": historical ? "publish" : undefined,
            }),
            read_only: true,
            font_size: 14,
            project_id: "p",
            path: "x.chat",
            id: "artifact-frame",
          } as any)}
        />
      </FileContext.Provider>,
    );
    expect(
      screen.getByRole("heading", { name: "A readable heading" }),
    ).toBeTruthy();
    expect(
      screen.getByText("unsafe link").closest("a")?.getAttribute("href"),
    ).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("window.attack()");
    expect(container.querySelector('img[src*="example.com"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  },
);
