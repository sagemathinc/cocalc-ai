import "../elements/types";
import {
  splitMarkdownToBlocks,
  splitMarkdownToBlocksIncremental,
} from "../block-chunking";
import { act, render, screen } from "@testing-library/react";
import BlockMarkdownEditor from "../block-markdown-editor-core";

jest.mock("../upload", () => ({
  __esModule: true,
  default: (_editor, body) => body,
}));

test("block chunking preserves heading markdown", () => {
  expect(splitMarkdownToBlocks("# foo")).toEqual(["# foo"]);
});

test("incremental block chunking preserves a heading when growing from empty", () => {
  expect(splitMarkdownToBlocksIncremental("", "# foo", [""])).toEqual([
    "# foo",
  ]);
});

test("block editor renders a synced heading as a single heading block", () => {
  const { rerender, container } = render(
    <BlockMarkdownEditor
      value=""
      read_only={true}
      hidePath={true}
      minimal={true}
      height="300px"
      noVfill={true}
      actions={{}}
      disableVirtualization={true}
    />,
  );

  rerender(
    <BlockMarkdownEditor
      value="# foo"
      read_only={true}
      hidePath={true}
      minimal={true}
      height="300px"
      noVfill={true}
      actions={{}}
      disableVirtualization={true}
    />,
  );

  expect(screen.getByRole("heading", { level: 1, name: "foo" })).toBeTruthy();
  expect(screen.queryByText("Page 2")).toBeNull();
  expect(container.querySelectorAll("[data-slate-block-index]").length).toBe(1);
});

test("block editor preserves heading rendering when syncstring updates from empty", () => {
  class FakeSyncstring {
    private value: string;
    private listeners = new Set<() => void>();

    constructor(initial: string) {
      this.value = initial;
    }

    to_str() {
      return this.value;
    }

    set(value: string) {
      this.value = value;
      for (const cb of this.listeners) cb();
    }

    on(event: string, cb: () => void) {
      if (event === "change") this.listeners.add(cb);
    }

    removeListener(event: string, cb: () => void) {
      if (event === "change") this.listeners.delete(cb);
    }
  }

  const sync = new FakeSyncstring("");
  const { container } = render(
    <BlockMarkdownEditor
      value=""
      read_only={true}
      hidePath={true}
      minimal={true}
      height="300px"
      noVfill={true}
      actions={{ _syncstring: sync } as any}
      disableVirtualization={true}
    />,
  );

  act(() => {
    sync.set("# foo");
  });

  expect(screen.getByRole("heading", { level: 1, name: "foo" })).toBeTruthy();
  expect(screen.queryByText("Page 2")).toBeNull();
  expect(container.querySelectorAll("[data-slate-block-index]").length).toBe(1);
});
