/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, type List } from "immutable";

type ClipboardModule = typeof import("./cell-clipboard");

// One browser: tabs share localStorage but each loads its own copy of the
// module (its own in-memory clipboard).
function fakeStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, `${value}`),
  };
}

function openTab(): ClipboardModule {
  let tab: ClipboardModule | undefined;
  jest.isolateModules(() => {
    tab = require("./cell-clipboard");
  });
  return tab!;
}

function cells(...inputs: string[]): List<any> {
  return fromJS(
    inputs.map((input, i) => ({
      type: "cell",
      id: `id${i}`,
      pos: i,
      cell_type: "code",
      input,
      output: { "0": { name: "stdout", text: `${input}\n` } },
    })),
  ) as List<any>;
}

function inputs(clipboard?: List<any>): string[] | undefined {
  return clipboard?.toJS().map((cell: any) => cell.input);
}

describe("notebook cell clipboard", () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    (globalThis as any).window = { localStorage: storage };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("pastes cells copied in another tab, outputs included", () => {
    const a = openTab();
    const b = openTab();
    a.setCellClipboard(cells("x = 1", "print(x)"), 1000);
    const pasted = b.getCellClipboard(2000);
    expect(inputs(pasted)).toEqual(["x = 1", "print(x)"]);
    expect(pasted?.getIn([1, "output", "0", "text"])).toBe("print(x)\n");
  });

  it("uses whichever tab copied most recently", () => {
    const a = openTab();
    const b = openTab();
    a.setCellClipboard(cells("from a"), 1000);
    b.setCellClipboard(cells("from b"), 2000);
    expect(inputs(a.getCellClipboard(3000))).toEqual(["from b"]);
    expect(inputs(b.getCellClipboard(3000))).toEqual(["from b"]);
    a.setCellClipboard(cells("from a again"), 4000);
    expect(inputs(b.getCellClipboard(5000))).toEqual(["from a again"]);
  });

  it("ignores and removes a stored copy older than a day", () => {
    const a = openTab();
    a.setCellClipboard(cells("old"), 1000);
    const b = openTab();
    expect(
      b.getCellClipboard(1000 + b.CELL_CLIPBOARD_MAX_AGE_MS + 1),
    ).toBeUndefined();
    expect(storage.data.size).toBe(0);
  });

  it("keeps a copy too large to share in its tab, and never pastes an older shared one", () => {
    const a = openTab();
    const b = openTab();
    a.setCellClipboard(cells("small"), 1000);
    const huge = "x".repeat(a.CELL_CLIPBOARD_MAX_STORED_CHARS);
    b.setCellClipboard(cells(huge), 2000);
    expect(inputs(b.getCellClipboard(3000))).toEqual([huge]);
    expect(storage.data.size).toBe(0);
    // tab a keeps its own copy, but does not get the stale one back later
    expect(inputs(a.getCellClipboard(3000))).toEqual(["small"]);
    expect(inputs(openTab().getCellClipboard(3000))).toBeUndefined();
  });

  it("clears the shared and in-memory copy (sign-out)", () => {
    const a = openTab();
    a.setCellClipboard(cells("secret"), 1000);
    a.clearCellClipboard();
    expect(a.getCellClipboard(2000)).toBeUndefined();
    expect(openTab().getCellClipboard(2000)).toBeUndefined();
  });

  it("ignores a corrupt stored value", () => {
    storage.setItem("cocalc-jupyter-cell-clipboard", "{not json");
    expect(openTab().getCellClipboard(1000)).toBeUndefined();
    expect(storage.data.size).toBe(0);
  });

  it("works in memory without a browser", () => {
    delete (globalThis as any).window;
    const a = openTab();
    a.setCellClipboard(cells("x"), 1000);
    expect(inputs(a.getCellClipboard(2000))).toEqual(["x"]);
  });

  it("keeps working when storage throws", () => {
    (globalThis as any).window = {
      get localStorage(): Storage {
        throw Error("SecurityError");
      },
    };
    const a = openTab();
    a.setCellClipboard(cells("x"), 1000);
    expect(inputs(a.getCellClipboard(2000))).toEqual(["x"]);
  });
});
