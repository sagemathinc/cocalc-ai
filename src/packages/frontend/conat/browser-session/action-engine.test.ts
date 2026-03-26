/** @jest-environment jsdom */

import { executeBrowserAction } from "./action-engine";

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
});
