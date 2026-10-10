// Injected into every frame of every page.
// - Headless Chromium does not draw native <select> popups into the
//   screencast, so while a human drives, a click on a <select> is reported to
//   the viewer, which draws its own menu.
// - The selected text is reported, so the viewer can put it on the human's
//   clipboard (Ctrl/Cmd+C, its Copy button): headless Chromium's own
//   clipboard is out of reach.
// - While a human drives, what the page itself copies (a site's copy button,
//   its own copy handler) is reported too, for the human's clipboard.
export const SELECT_BINDING = "__cocalcSharedBrowserSelect";

// The most text one selection or copy carries to the viewer.
export const MAX_CLIPBOARD_TEXT = 1_000_000;

export function selectScript(humanDriving: boolean): string {
  return `(() => {
  window.__cocalcHumanDriving = ${humanDriving ? "true" : "false"};
  if (window.__cocalcSelectHooked) return;
  window.__cocalcSelectHooked = true;
  const report = (payload) => { try { globalThis.${SELECT_BINDING}(JSON.stringify(payload)); } catch {} };
  addEventListener("mousedown", (event) => {
    if (!window.__cocalcHumanDriving) return;
    const el = event.target && event.target.closest && event.target.closest("select");
    if (!el || el.multiple || el.size > 1 || el.disabled) return;
    event.preventDefault();
    el.focus();
    window.__cocalcSelectElement = el;
    const options = Array.from(el.options).map((o) => ({
      label: o.label || o.text,
      disabled: o.disabled || (o.parentElement && o.parentElement.disabled === true),
      group: o.parentElement && o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : undefined,
    }));
    report({ options, selected: el.selectedIndex });
  }, true);

  const clip = (text) => String(text).slice(0, ${MAX_CLIPBOARD_TEXT});
  const selectionText = () => {
    const el = document.activeElement;
    const field = el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type !== "password"));
    try {
      if (field && el.selectionEnd > el.selectionStart) return el.value.slice(el.selectionStart, el.selectionEnd);
    } catch {}
    const selection = getSelection();
    return selection ? selection.toString() : "";
  };
  let lastSelection = "", selectionTimer = null;
  // In a text field, the event is fired at the field and bubbles.
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const text = clip(selectionText());
      if (text === lastSelection) return;
      lastSelection = text;
      report({ type: "selection", text });
    }, 100);
  }, true);

  const copied = (text) => { if (window.__cocalcHumanDriving && text) report({ type: "copied", text: clip(text) }); };
  // A copy event: what its handlers put on the clipboard, else the selection.
  let copying = null;
  const setData = DataTransfer.prototype.setData;
  DataTransfer.prototype.setData = function (format, data) {
    if (copying !== null && /^text(\\/plain)?$/i.test(format)) copying = String(data);
    return setData.apply(this, arguments);
  };
  for (const type of ["copy", "cut"])
    addEventListener(type, () => {
      copying = "";
      setTimeout(() => { const text = copying || selectionText(); copying = null; copied(text); }, 0);
    }, true);
  // The async clipboard API, e.g. a site's copy button.  It succeeds for the
  // page: the copy goes to the human.
  const clipboard = navigator.clipboard;
  if (clipboard) {
    const writeText = clipboard.writeText && clipboard.writeText.bind(clipboard);
    const write = clipboard.write && clipboard.write.bind(clipboard);
    clipboard.writeText = (text) => {
      copied(text);
      return writeText ? writeText(text).catch(() => {}) : Promise.resolve();
    };
    clipboard.write = async (items) => {
      try {
        for (const item of items || [])
          if (item.types.includes("text/plain")) { copied(await (await item.getType("text/plain")).text()); break; }
      } catch {}
      if (write) await write(items).catch(() => {});
    };
  }
})();`;
}

export function pickSelectExpression(index: number): string {
  return `(() => {
  const el = window.__cocalcSelectElement;
  if (!el || !el.isConnected) return false;
  if (el.selectedIndex !== ${index}) {
    el.selectedIndex = ${index};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
})()`;
}
