/** @jest-environment jsdom */

import { executeBrowserAction } from "./action-engine";
import { createElement, useState } from "react";
import { act, render, screen } from "@testing-library/react";

it.each(["input", "textarea"])(
  "updates React controlled %s values through typed actions",
  async (tag) => {
    function Controlled() {
      const [value, setValue] = useState("before");
      return createElement(tag, {
        "aria-label": "Controlled input",
        value,
        onChange: (event) => setValue(event.target.value),
      });
    }
    const view = render(createElement(Controlled));
    for (const [text, append, expected] of [
      ["after", false, "after"],
      [" appended", true, "after appended"],
    ] as const) {
      await act(async () => {
        await executeBrowserAction({
          project_id: "94ee01cf-2d7a-4e56-b8af-76d9a697877b",
          action: { name: "type", selector: tag, text, append },
        });
      });
      view.rerender(createElement(Controlled));
      expect(
        (screen.getByLabelText("Controlled input") as HTMLInputElement).value,
      ).toBe(expected);
    }
    view.unmount();
  },
);

describe("browser action-engine contenteditable typing", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("dispatches beforeinput for contenteditable targets", async () => {
    const textbox = document.createElement("div");
    textbox.setAttribute("role", "textbox");
    textbox.setAttribute("contenteditable", "true");
    let value = "";
    const send = document.createElement("button");
    send.disabled = true;
    textbox.addEventListener("beforeinput", (event) => {
      const input = event as InputEvent;
      if (input.inputType === "insertText") {
        value += input.data ?? "";
        textbox.textContent = value;
        send.disabled = value.trim().length === 0;
      }
      event.preventDefault();
    });
    document.body.appendChild(textbox);
    document.body.appendChild(send);

    await executeBrowserAction({
      project_id: "94ee01cf-2d7a-4e56-b8af-76d9a697877b",
      action: {
        name: "type",
        selector: "[role='textbox']",
        text: "hello",
      },
    });

    expect((textbox.textContent ?? "").trim()).toBe("hello");
    expect(send.disabled).toBe(false);
  });

  it("selects an enabled native option and emits change with focus", async () => {
    document.body.innerHTML =
      '<select aria-label="Appearance"><option value="light">Light</option><option value="dark">Dark</option></select>';
    const select = document.querySelector("select")!;
    const changed = jest.fn();
    select.addEventListener("change", changed);
    await executeBrowserAction({
      project_id: "94ee01cf-2d7a-4e56-b8af-76d9a697877b",
      action: {
        name: "type",
        selector: 'select[aria-label="Appearance"]',
        text: "dark",
      },
    });
    expect(select.value).toBe("dark");
    expect(document.activeElement).toBe(select);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["disabled", '<option value="dark">Dark</option>', "dark"],
    ["multiple", '<option value="dark">Dark</option>', "dark"],
    ["", '<option value="dark" disabled>Dark</option>', "dark"],
    [
      "",
      '<optgroup disabled><option value="dark">Dark</option></optgroup>',
      "dark",
    ],
    ["", '<option value="light">Light</option>', "missing"],
  ])(
    "rejects unavailable select choices (%s %s)",
    async (attributes, options, text) => {
      document.body.innerHTML = `<select ${attributes}>${options}</select>`;
      const select = document.querySelector("select")!;
      const before = select.value;
      await expect(
        executeBrowserAction({
          project_id: "94ee01cf-2d7a-4e56-b8af-76d9a697877b",
          action: { name: "type", selector: "select", text },
        }),
      ).rejects.toThrow(/select/);
      expect(select.value).toBe(before);
    },
  );

  it("uses the Slate-style React beforeinput hook when present", async () => {
    const textbox = document.createElement("div");
    textbox.setAttribute("role", "textbox");
    textbox.setAttribute("contenteditable", "true");
    textbox.setAttribute("data-slate-editor", "true");
    let value = "";
    const send = document.createElement("button");
    send.disabled = true;
    (textbox as any).__reactProps$test = {
      onBeforeInput: (event) => {
        const native = event?.nativeEvent as InputEvent | undefined;
        value += native?.data ?? "";
        textbox.textContent = value;
        send.disabled = value.trim().length === 0;
      },
    };
    document.body.appendChild(textbox);
    document.body.appendChild(send);

    await executeBrowserAction({
      project_id: "94ee01cf-2d7a-4e56-b8af-76d9a697877b",
      action: {
        name: "type",
        selector: "[role='textbox']",
        text: "agent",
      },
    });

    expect((textbox.textContent ?? "").trim()).toBe("agent");
    expect(send.disabled).toBe(false);
  });

  it("uses semantic HTMLElement.click() for ordinary selector clicks", async () => {
    const button = document.createElement("button");
    let clicked = 0;
    button.onclick = () => {
      clicked += 1;
    };
    button.scrollIntoView = () => {};
    button.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        width: 100,
        height: 30,
        right: 110,
        bottom: 50,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(button);
    document.elementFromPoint = () => {
      throw new Error(
        "elementFromPoint should not be needed for semantic click",
      );
    };

    await executeBrowserAction({
      project_id: "94ee01cf-2d7a-4e56-b8af-76d9a697877b",
      action: {
        name: "click",
        selector: "button",
      },
    });

    expect(clicked).toBe(1);
  });

  it("uploads a bounded in-memory file through a file input", async () => {
    class TestDataTransfer {
      private readonly transferredFiles: File[] = [];
      public readonly items = {
        add: (file: File) => this.transferredFiles.push(file),
      };
      get fileList(): FileList {
        return this.transferredFiles as unknown as FileList;
      }
    }
    const originalDataTransfer = global.DataTransfer;
    Object.defineProperty(global, "DataTransfer", {
      configurable: true,
      value: class extends TestDataTransfer {
        get files(): FileList {
          return this.fileList;
        }
      },
    });
    try {
      const input = document.createElement("input");
      input.type = "file";
      let files: FileList | null = null;
      Object.defineProperty(input, "files", {
        configurable: true,
        get: () => files,
        set: (value) => {
          files = value;
        },
      });
      let changed = false;
      input.addEventListener("change", () => {
        changed = true;
      });
      document.body.appendChild(input);

      const result = await executeBrowserAction({
        project_id: "94ee01cf-2d7a-4e56-b8af-76d9a697877b",
        action: {
          name: "upload_file",
          selector: "input[type='file']",
          filename: "fixture.txt",
          content_base64: btoa("hello"),
          mime_type: "text/plain",
        },
      });

      expect(result).toEqual(
        expect.objectContaining({
          name: "upload_file",
          filename: "fixture.txt",
          bytes: 5,
        }),
      );
      expect(changed).toBe(true);
      expect(input.files?.[0]?.name).toBe("fixture.txt");
    } finally {
      Object.defineProperty(global, "DataTransfer", {
        configurable: true,
        value: originalDataTransfer,
      });
    }
  });
});
