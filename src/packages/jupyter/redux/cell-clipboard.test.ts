/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, type List } from "immutable";

type ClipboardModule = typeof import("./cell-clipboard");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

// One browser: tabs share localStorage, but each loads its own copy of the
// module (its own memory).
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

function openTab(account: string | null = ALICE): ClipboardModule {
  let tab: ClipboardModule | undefined;
  jest.isolateModules(() => {
    tab = require("./cell-clipboard");
  });
  tab!.setCellClipboardAccount(account ?? undefined);
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

  it("uses the latest copy of any tab, even within the same millisecond", () => {
    const a = openTab();
    const b = openTab();
    a.setCellClipboard(cells("from a"), 1000);
    b.setCellClipboard(cells("from b"), 1000);
    expect(inputs(a.getCellClipboard(1000))).toEqual(["from b"]);
    expect(inputs(b.getCellClipboard(1000))).toEqual(["from b"]);
    a.setCellClipboard(cells("from a again"), 1000);
    expect(inputs(a.getCellClipboard(1000))).toEqual(["from a again"]);
    expect(inputs(b.getCellClipboard(1000))).toEqual(["from a again"]);
  });

  it("a clear in one tab also clears cells another tab already pasted", () => {
    const a = openTab();
    const b = openTab();
    a.setCellClipboard(cells("secret"), 1000);
    expect(inputs(b.getCellClipboard(2000))).toEqual(["secret"]);
    a.clearCellClipboard(3000);
    expect(b.getCellClipboard(4000)).toBeUndefined();
    expect(a.getCellClipboard(4000)).toBeUndefined();
    expect(openTab().getCellClipboard(4000)).toBeUndefined();
  });

  it("a clear in another tab also forgets this tab's own copy", () => {
    const a = openTab();
    const b = openTab();
    a.setCellClipboard(cells("secret"), 1000);
    b.clearCellClipboard(2000);
    expect(a.getCellClipboard(3000)).toBeUndefined();
  });

  it("a copy too large to share stays in its tab and stops other tabs pasting older copies", () => {
    const a = openTab();
    const b = openTab();
    a.setCellClipboard(cells("small"), 1000);
    expect(inputs(b.getCellClipboard(1500))).toEqual(["small"]);
    const huge = "x".repeat(a.CELL_CLIPBOARD_MAX_STORED_CHARS);
    b.setCellClipboard(cells(huge), 2000);
    expect(inputs(b.getCellClipboard(3000))).toEqual([huge]);
    expect(a.getCellClipboard(3000)).toBeUndefined();
    expect(openTab().getCellClipboard(3000)).toBeUndefined();
    // the tombstone holds no cells
    expect(storage.data.get("cocalc-jupyter-cell-clipboard")).not.toContain(
      "xxxx",
    );
  });

  it("falls back to a tombstone when storage is full", () => {
    const a = openTab();
    const b = openTab();
    a.setCellClipboard(cells("old"), 1000);
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (value.length > 200) throw Error("QuotaExceededError");
      setItem(key, value);
    };
    b.setCellClipboard(cells("y".repeat(300)), 2000);
    expect(a.getCellClipboard(3000)).toBeUndefined();
    expect(inputs(b.getCellClipboard(3000))).toEqual(["y".repeat(300)]);
  });

  it("only pastes copies made by the same account", () => {
    const alice = openTab(ALICE);
    alice.setCellClipboard(cells("alice's"), 1000);
    expect(openTab(BOB).getCellClipboard(2000)).toBeUndefined();
    expect(openTab(null).getCellClipboard(2000)).toBeUndefined();
    expect(inputs(openTab(ALICE).getCellClipboard(2000))).toEqual(["alice's"]);
  });

  it("forgets this tab's copy when the account changes", () => {
    delete (globalThis as any).window; // memory only
    const tab = openTab(ALICE);
    tab.setCellClipboard(cells("alice's"), 1000);
    tab.setCellClipboardAccount(BOB);
    expect(tab.getCellClipboard(2000)).toBeUndefined();
  });

  it("expires copies after a day, shared or not", () => {
    const a = openTab();
    a.setCellClipboard(cells("old"), 1000);
    const later = 1000 + a.CELL_CLIPBOARD_MAX_AGE_MS + 1;
    expect(openTab().getCellClipboard(later)).toBeUndefined();
    expect(a.getCellClipboard(later)).toBeUndefined();
    delete (globalThis as any).window;
    const c = openTab();
    c.setCellClipboard(cells("old"), 1000);
    expect(c.getCellClipboard(later)).toBeUndefined();
  });

  it("does not paste a corrupt stored value", () => {
    storage.setItem("cocalc-jupyter-cell-clipboard", "{not json");
    const a = openTab();
    expect(a.getCellClipboard(1000)).toBeUndefined();
    a.setCellClipboard(cells("fresh"), 2000);
    expect(inputs(openTab().getCellClipboard(3000))).toEqual(["fresh"]);
  });

  it("works in memory without a browser", () => {
    delete (globalThis as any).window;
    const a = openTab();
    a.setCellClipboard(cells("x"), 1000);
    expect(inputs(a.getCellClipboard(2000))).toEqual(["x"]);
    a.clearCellClipboard(3000);
    expect(a.getCellClipboard(4000)).toBeUndefined();
  });

  it("keeps working in memory when storage throws", () => {
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
