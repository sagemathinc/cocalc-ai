import { openFileComponentRuntimeIsUsable } from "./open-file-runtime";

function usable({
  info,
  isViewer = false,
  actions,
  store,
}: {
  info: any;
  isViewer?: boolean;
  actions?: any;
  store?: any;
}): boolean {
  return openFileComponentRuntimeIsUsable({
    info,
    isViewer,
    getActions: () => actions,
    getStore: () => store,
  });
}

describe("openFileComponentRuntimeIsUsable", () => {
  const Editor = () => null;

  it("rejects rows without an editor component", () => {
    expect(usable({ info: { redux_name: "editor" }, actions: {} })).toBe(false);
  });

  it("allows component-only editors without redux actions", () => {
    expect(usable({ info: { Editor }, isViewer: true })).toBe(true);
    expect(usable({ info: { Editor }, isViewer: false })).toBe(true);
  });

  it("rejects stale runtime references", () => {
    expect(
      usable({ info: { Editor, redux_name: "editor" }, actions: undefined }),
    ).toBe(false);
    expect(
      usable({
        info: { Editor, redux_name: "editor" },
        actions: {},
        store: undefined,
      }),
    ).toBe(false);
    expect(
      usable({
        info: { Editor, redux_name: "editor" },
        actions: { isClosed: () => true },
        store: {},
      }),
    ).toBe(false);
  });

  it("allows live editor runtimes", () => {
    expect(
      usable({
        info: { Editor, redux_name: "editor" },
        actions: { isClosed: () => false },
        store: {},
      }),
    ).toBe(true);
  });
});
