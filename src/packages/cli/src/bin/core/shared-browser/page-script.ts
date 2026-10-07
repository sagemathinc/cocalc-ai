// Injected into every frame of every page.  Headless Chromium does not draw
// native <select> popups into the screencast, so while a human drives, a
// click on a <select> is reported to the viewer, which draws its own menu.
export const SELECT_BINDING = "__cocalcSharedBrowserSelect";

export function selectScript(humanDriving: boolean): string {
  return `(() => {
  window.__cocalcHumanDriving = ${humanDriving ? "true" : "false"};
  if (window.__cocalcSelectHooked) return;
  window.__cocalcSelectHooked = true;
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
    globalThis.${SELECT_BINDING}(JSON.stringify({ options, selected: el.selectedIndex }));
  }, true);
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
