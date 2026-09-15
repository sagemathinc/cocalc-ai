import { set_state } from "./codemirror-state";

describe("CodeMirror scroll restoration", () => {
  it("restores position and selection without global jQuery", async () => {
    const previous = globalThis.$;
    delete (globalThis as any).$;
    const wrapper = document.createElement("div");
    const scroller = document.createElement("div");
    scroller.className = "CodeMirror-scroll";
    scroller.style.height = "100px";
    wrapper.appendChild(scroller);
    document.body.appendChild(wrapper);
    const setSelections = jest.fn();
    const cm = {
      getWrapperElement: () => wrapper,
      cursorCoords: jest.fn(() => ({ top: 42 })),
      scrollTo: jest.fn(),
      refresh: jest.fn(),
      getDoc: () => ({ setSelections }),
    };
    const sel = [{ anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 2 } }];
    try {
      await set_state(cm as any, { ver: 2, pos: { line: 1, ch: 0 }, sel });
      expect(cm.scrollTo).toHaveBeenCalledWith(0, 42);
      expect(scroller.style.opacity).toBe("1");
      expect(setSelections).toHaveBeenCalledWith(sel, undefined, {
        scroll: false,
      });
    } finally {
      wrapper.remove();
      globalThis.$ = previous;
    }
  });
});
