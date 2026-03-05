/*
Browser session typed action engine.

This module contains the DOM-side implementation for typed automation actions
(click/type/press/drag/scroll/wait/navigate/reload/batch). It is kept separate
from the session lifecycle/service wiring so behavior can be audited and tested
in isolation.
*/

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  type BrowserActionRequest,
  type BrowserActionResult,
  type BrowserAtomicActionRequest,
  type BrowserCoordinateSpace,
  type BrowserScreenshotMetadata,
} from "@cocalc/conat/service/browser-session";
import { isValidUUID } from "@cocalc/util/misc";

function asFinitePositive(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(`${value}`);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return num;
}

function asFiniteNonNegative(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(`${value}`);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return num;
}

function appBasePrefix(): string {
  const clean = `${appBasePath ?? ""}`.trim();
  if (!clean || clean === "/") return "/";
  return clean.endsWith("/") ? clean.slice(0, -1) : clean;
}

function isSpaNavigableUrl(url: URL): boolean {
  if (url.origin !== location.origin) return false;
  const base = appBasePrefix();
  if (base === "/") return true;
  return url.pathname === base || url.pathname.startsWith(`${base}/`);
}

function toSpaTarget(url: URL): string {
  const base = appBasePrefix();
  const path = base === "/" ? url.pathname : url.pathname.slice(base.length);
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  const decoded = decodeURIComponent(trimmed);
  const hash = `${url.hash ?? ""}`.trim();
  return hash ? `${decoded}${hash}` : decoded;
}

const sleepMs = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const isElementVisible = (element: Element | null): boolean => {
  if (!element || !(element as any).isConnected) return false;
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }
  return true;
};

const querySelectorSafe = (selector: string): Element | null => {
  try {
    return document.querySelector(selector);
  } catch (err) {
    throw Error(`invalid selector '${selector}': ${err}`);
  }
};

const waitForSelectorState = async ({
  selector,
  state,
  timeout_ms,
  poll_ms,
}: {
  selector: string;
  state: "attached" | "visible" | "hidden" | "detached";
  timeout_ms: number;
  poll_ms: number;
}): Promise<{ element: Element | null; state: string }> => {
  const started = Date.now();
  const deadline = started + timeout_ms;
  for (;;) {
    const element = querySelectorSafe(selector);
    const visible = isElementVisible(element);
    const ok =
      state === "attached"
        ? !!element
        : state === "visible"
          ? !!element && visible
          : state === "hidden"
            ? !element || !visible
            : !element;
    if (ok) {
      return { element, state };
    }
    if (Date.now() >= deadline) {
      throw Error(
        `timed out waiting for selector '${selector}' to become ${state}`,
      );
    }
    await sleepMs(Math.max(20, poll_ms));
  }
};

const normalizeScreenshotMeta = (
  meta: unknown,
): BrowserScreenshotMetadata | undefined => {
  if (!meta || typeof meta !== "object") return undefined;
  return meta as BrowserScreenshotMetadata;
};

const buttonIndex = (button: "left" | "middle" | "right"): number =>
  button === "middle" ? 1 : button === "right" ? 2 : 0;

const buttonsMask = (button: "left" | "middle" | "right"): number =>
  button === "middle" ? 4 : button === "right" ? 2 : 1;

const targetAtPoint = (clientX: number, clientY: number): Element => {
  const target = document.elementFromPoint(clientX, clientY);
  if (!target) {
    throw Error(`no element at point (${clientX.toFixed(2)}, ${clientY.toFixed(2)})`);
  }
  return target;
};

const dispatchPointerMouse = ({
  target,
  type,
  init,
}: {
  target: Element;
  type: "pointerdown" | "pointermove" | "pointerup";
  init: MouseEventInit;
}) => {
  if (typeof PointerEvent !== "undefined") {
    const pointerInit: PointerEventInit = {
      ...init,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    target.dispatchEvent(new PointerEvent(type, pointerInit));
  }
  const mouseType =
    type === "pointerdown"
      ? "mousedown"
      : type === "pointerup"
        ? "mouseup"
        : "mousemove";
  target.dispatchEvent(new MouseEvent(mouseType, init));
};

const dispatchClickAtPoint = ({
  clientX,
  clientY,
  button,
  clickIndex,
}: {
  clientX: number;
  clientY: number;
  button: "left" | "middle" | "right";
  clickIndex: number;
}) => {
  const detail = clickIndex + 1;
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: buttonIndex(button),
    buttons: buttonsMask(button),
    detail,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
  };
  const downTarget = targetAtPoint(clientX, clientY);
  if (downTarget instanceof HTMLElement) {
    downTarget.focus({ preventScroll: true });
  }
  dispatchPointerMouse({ target: downTarget, type: "pointerdown", init });
  const upTarget = targetAtPoint(clientX, clientY);
  dispatchPointerMouse({ target: upTarget, type: "pointerup", init });
  if (button === "right") {
    upTarget.dispatchEvent(new MouseEvent("contextmenu", init));
  } else if (button === "middle") {
    upTarget.dispatchEvent(new MouseEvent("auxclick", init));
  } else {
    upTarget.dispatchEvent(new MouseEvent("click", init));
    if (detail === 2) {
      upTarget.dispatchEvent(new MouseEvent("dblclick", init));
    }
  }
};

const dispatchDrag = async ({
  start,
  end,
  button,
  steps,
  hold_ms,
}: {
  start: { clientX: number; clientY: number };
  end: { clientX: number; clientY: number };
  button: "left" | "middle" | "right";
  steps: number;
  hold_ms: number;
}) => {
  const downInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: buttonIndex(button),
    buttons: buttonsMask(button),
    detail: 1,
    clientX: start.clientX,
    clientY: start.clientY,
    screenX: start.clientX,
    screenY: start.clientY,
  };
  const startTarget = targetAtPoint(start.clientX, start.clientY);
  if (startTarget instanceof HTMLElement) {
    startTarget.focus({ preventScroll: true });
  }
  dispatchPointerMouse({ target: startTarget, type: "pointerdown", init: downInit });
  if (hold_ms > 0) {
    await sleepMs(hold_ms);
  }
  const safeSteps = Math.max(1, Math.floor(steps));
  for (let i = 1; i <= safeSteps; i++) {
    const t = i / safeSteps;
    const x = start.clientX + (end.clientX - start.clientX) * t;
    const y = start.clientY + (end.clientY - start.clientY) * t;
    const moveTarget = targetAtPoint(x, y);
    const moveInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: buttonIndex(button),
      buttons: buttonsMask(button),
      detail: 0,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
    };
    dispatchPointerMouse({ target: moveTarget, type: "pointermove", init: moveInit });
    if (i < safeSteps) {
      await sleepMs(12);
    }
  }
  const endTarget = targetAtPoint(end.clientX, end.clientY);
  const upInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: buttonIndex(button),
    buttons: 0,
    detail: 1,
    clientX: end.clientX,
    clientY: end.clientY,
    screenX: end.clientX,
    screenY: end.clientY,
  };
  dispatchPointerMouse({ target: endTarget, type: "pointerup", init: upInit });
};

const resolveCoordinatePoint = async ({
  x,
  y,
  space,
  selector,
  timeout_ms,
  screenshot_meta,
  strict_meta,
}: {
  x: number;
  y: number;
  space: BrowserCoordinateSpace;
  selector?: string;
  timeout_ms: number;
  screenshot_meta?: BrowserScreenshotMetadata;
  strict_meta?: boolean;
}): Promise<{
  clientX: number;
  clientY: number;
  selector_used?: string;
  meta_rect_drift?: { dx: number; dy: number; dw: number; dh: number };
}> => {
  const viewport = {
    width: Number(window.innerWidth || 0),
    height: Number(window.innerHeight || 0),
  };
  const meta = normalizeScreenshotMeta(screenshot_meta);
  const selectorFromMeta = `${meta?.selector ?? ""}`.trim();
  const selectorUsed = `${selector ?? ""}`.trim() || selectorFromMeta;

  if (strict_meta && `${meta?.page_url ?? ""}`.trim()) {
    const expected = `${meta?.page_url ?? ""}`.trim();
    const current = `${location.href ?? ""}`.trim();
    if (expected !== current) {
      throw Error(
        `strict metadata mismatch: page_url differs (expected '${expected}', current '${current}')`,
      );
    }
  }
  if (strict_meta && selectorFromMeta && selector && selectorFromMeta !== selector) {
    throw Error(
      `strict metadata mismatch: selector differs (meta='${selectorFromMeta}', request='${selector}')`,
    );
  }

  if (space === "viewport") {
    return { clientX: x, clientY: y, ...(selectorUsed ? { selector_used: selectorUsed } : {}) };
  }
  if (space === "normalized") {
    return {
      clientX: x * viewport.width,
      clientY: y * viewport.height,
      ...(selectorUsed ? { selector_used: selectorUsed } : {}),
    };
  }
  if ((space === "selector" || space === "image") && !selectorUsed) {
    throw Error("selector is required for selector/image coordinate space");
  }

  const found = await waitForSelectorState({
    selector: selectorUsed,
    state: "visible",
    timeout_ms,
    poll_ms: 50,
  });
  const element = found.element;
  if (!element) {
    throw Error(`selector '${selectorUsed}' not found`);
  }
  const rect = element.getBoundingClientRect();
  const drift =
    meta?.selector_rect_css != null
      ? {
          dx: Number(rect.left) - Number(meta.selector_rect_css.left ?? 0),
          dy: Number(rect.top) - Number(meta.selector_rect_css.top ?? 0),
          dw: Number(rect.width) - Number(meta.selector_rect_css.width ?? 0),
          dh: Number(rect.height) - Number(meta.selector_rect_css.height ?? 0),
        }
      : undefined;
  if (strict_meta && drift) {
    const tol = Math.max(8, Math.min(Number(rect.width || 0), Number(rect.height || 0)) * 0.2);
    if (
      Math.abs(drift.dx) > tol ||
      Math.abs(drift.dy) > tol ||
      Math.abs(drift.dw) > tol ||
      Math.abs(drift.dh) > tol
    ) {
      throw Error(
        `strict metadata mismatch: selector rectangle drifted too much (dx=${drift.dx.toFixed(
          2,
        )}, dy=${drift.dy.toFixed(2)}, dw=${drift.dw.toFixed(2)}, dh=${drift.dh.toFixed(2)})`,
      );
    }
  }

  if (space === "selector") {
    return {
      clientX: Number(rect.left || 0) + x,
      clientY: Number(rect.top || 0) + y,
      selector_used: selectorUsed,
      ...(drift ? { meta_rect_drift: drift } : {}),
    };
  }
  const scale = Math.max(0.0001, Number(meta?.capture_scale ?? 1));
  return {
    clientX: Number(rect.left || 0) + x / scale,
    clientY: Number(rect.top || 0) + y / scale,
    selector_used: selectorUsed,
    ...(drift ? { meta_rect_drift: drift } : {}),
  };
};

export async function executeBrowserAction({
  project_id,
  action,
}: {
  project_id: string;
  action: BrowserActionRequest;
}): Promise<BrowserActionResult> {
  if (!isValidUUID(project_id)) {
    throw Error("project_id must be a UUID");
  }
  if (typeof document === "undefined" || typeof window === "undefined") {
    throw Error("browser automation actions require a DOM environment");
  }
  const started = Date.now();
  if (!action || typeof action !== "object") {
    throw Error("action must be specified");
  }

  if (action.name === "batch") {
    const steps = Array.isArray(action.actions) ? action.actions : [];
    if (!steps.length) {
      throw Error("batch requires at least one action");
    }
    const continueOnError = !!action.continue_on_error;
    const results: Array<Record<string, unknown>> = [];
    let failed = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepName = `${(step as any)?.name ?? ""}`.trim();
      if (!stepName || stepName === "batch") {
        const message = `batch step ${i} has invalid action name '${stepName || "<empty>"}'`;
        if (!continueOnError) {
          throw Error(message);
        }
        failed += 1;
        results.push({
          index: i,
          ok: false,
          action_name: stepName || "",
          error: message,
        });
        continue;
      }
      try {
        const stepResult = await executeBrowserAction({
          project_id,
          action: step as BrowserAtomicActionRequest,
        });
        results.push({
          index: i,
          ok: true,
          action_name: stepResult.name,
          result: stepResult,
        });
      } catch (err) {
        const message = `${err}`;
        if (!continueOnError) {
          throw Error(`batch step ${i} (${stepName}) failed: ${message}`);
        }
        failed += 1;
        results.push({
          index: i,
          ok: false,
          action_name: stepName,
          error: message,
        });
      }
    }
    return {
      name: "batch",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      step_count: steps.length,
      failed_steps: failed,
      continue_on_error: continueOnError,
      results,
    };
  }

  if (action.name === "navigate") {
    const url = `${action.url ?? ""}`.trim();
    if (!url) {
      throw Error("navigate requires a non-empty url");
    }
    let resolvedUrl = "";
    try {
      resolvedUrl = new URL(url, location.href).toString();
    } catch (err) {
      throw Error(`invalid navigate url '${url}': ${err}`);
    }
    const wait_for_url_ms = asFiniteNonNegative(action.wait_for_url_ms) ?? 0;
    const before = `${location.href ?? ""}`;
    const targetUrl = new URL(resolvedUrl, location.href);
    if (isSpaNavigableUrl(targetUrl)) {
      const target = toSpaTarget(targetUrl);
      const { load_target } = await import("@cocalc/frontend/history");
      load_target(target, false, true);
    } else {
      if (action.replace) {
        location.replace(resolvedUrl);
      } else {
        location.assign(resolvedUrl);
      }
    }
    if (wait_for_url_ms > 0) {
      const deadline = Date.now() + wait_for_url_ms;
      for (;;) {
        const href = `${location.href ?? ""}`;
        if (href !== before || href === resolvedUrl) {
          break;
        }
        if (Date.now() >= deadline) {
          throw Error("timed out waiting for URL change after navigate");
        }
        await sleepMs(50);
      }
    }
    return {
      name: "navigate",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      from_url: before,
      target_url: resolvedUrl,
      replace: !!action.replace,
    };
  }

  if (action.name === "reload") {
    const before = `${location.href ?? ""}`;
    const hard = !!action.hard;
    let target_url = before;
    if (hard) {
      try {
        const u = new URL(before);
        u.searchParams.set("_cocalc_reload", `${Date.now()}`);
        target_url = u.toString();
      } catch {
        target_url = `${before}${before.includes("?") ? "&" : "?"}_cocalc_reload=${Date.now()}`;
      }
    }
    const delay_ms = hard ? 150 : 50;
    setTimeout(() => {
      if (hard) {
        location.replace(target_url);
      } else {
        location.reload();
      }
    }, delay_ms);
    return {
      name: "reload",
      ok: true,
      page_url: before,
      elapsed_ms: Date.now() - started,
      from_url: before,
      target_url,
      hard_requested: hard,
      delay_ms,
      scheduled: true,
    };
  }

  if (action.name === "scroll_by") {
    const dx = Number(action.dx ?? 0);
    const dy = Number(action.dy ?? 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw Error("scroll_by requires finite dx/dy");
    }
    const behavior =
      `${action.behavior ?? "auto"}`.trim() === "smooth" ? "smooth" : "auto";
    const before = {
      x: Number(window.scrollX || window.pageXOffset || 0),
      y: Number(window.scrollY || window.pageYOffset || 0),
    };
    window.scrollBy({ left: dx, top: dy, behavior });
    await sleepMs(behavior === "smooth" ? 160 : 30);
    const after = {
      x: Number(window.scrollX || window.pageXOffset || 0),
      y: Number(window.scrollY || window.pageYOffset || 0),
    };
    return {
      name: "scroll_by",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      input: { dx, dy, behavior },
      before_scroll: before,
      after_scroll: after,
    };
  }

  if (action.name === "scroll_to") {
    const behavior =
      `${action.behavior ?? "auto"}`.trim() === "smooth" ? "smooth" : "auto";
    const before = {
      x: Number(window.scrollX || window.pageXOffset || 0),
      y: Number(window.scrollY || window.pageYOffset || 0),
    };
    const selector = `${action.selector ?? ""}`.trim();
    if (selector) {
      const timeout_ms = asFinitePositive(action.timeout_ms) ?? 30_000;
      const poll_ms = asFinitePositive(action.poll_ms) ?? 100;
      const { element } = await waitForSelectorState({
        selector,
        state: "attached",
        timeout_ms,
        poll_ms,
      });
      if (!element) {
        throw Error(`selector '${selector}' not found`);
      }
      const block =
        `${action.block ?? "center"}`.trim().toLowerCase() as
          | "start"
          | "center"
          | "end"
          | "nearest";
      const inline =
        `${action.inline ?? "nearest"}`.trim().toLowerCase() as
          | "start"
          | "center"
          | "end"
          | "nearest";
      element.scrollIntoView({
        behavior,
        block:
          block === "start" || block === "end" || block === "nearest"
            ? block
            : "center",
        inline:
          inline === "start" || inline === "center" || inline === "end"
            ? inline
            : "nearest",
      });
    } else {
      const top = Number(action.top ?? window.scrollY ?? 0);
      const left = Number(action.left ?? window.scrollX ?? 0);
      if (!Number.isFinite(top) || !Number.isFinite(left)) {
        throw Error("scroll_to requires finite top/left when selector is not provided");
      }
      window.scrollTo({ top, left, behavior });
    }
    await sleepMs(behavior === "smooth" ? 180 : 30);
    const after = {
      x: Number(window.scrollX || window.pageXOffset || 0),
      y: Number(window.scrollY || window.pageYOffset || 0),
    };
    return {
      name: "scroll_to",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      ...(selector ? { selector } : {}),
      input: {
        ...(action.top != null ? { top: Number(action.top) } : {}),
        ...(action.left != null ? { left: Number(action.left) } : {}),
        behavior,
        ...(action.block ? { block: action.block } : {}),
        ...(action.inline ? { inline: action.inline } : {}),
      },
      before_scroll: before,
      after_scroll: after,
    };
  }

  if (action.name === "wait_for_url") {
    const timeout_ms = asFinitePositive(action.timeout_ms) ?? 30_000;
    const poll_ms = asFinitePositive(action.poll_ms) ?? 100;
    const url = `${action.url ?? ""}`.trim();
    const includes = `${action.includes ?? ""}`.trim();
    const rawRegex = `${action.regex ?? ""}`.trim();
    let regex: RegExp | undefined;
    if (rawRegex) {
      try {
        const m = rawRegex.match(/^\/(.*)\/([gimsuy]*)$/);
        regex = m ? new RegExp(m[1], m[2]) : new RegExp(rawRegex);
      } catch (err) {
        throw Error(`invalid regex '${rawRegex}': ${err}`);
      }
    }
    if (!url && !includes && !regex) {
      throw Error("wait_for_url requires url, includes, or regex");
    }
    const matches = (href: string) =>
      (!url || href === url) &&
      (!includes || href.includes(includes)) &&
      (!regex || regex.test(href));
    const deadline = started + timeout_ms;
    for (;;) {
      const href = `${location.href ?? ""}`;
      if (matches(href)) {
        return {
          name: "wait_for_url",
          ok: true,
          page_url: href,
          elapsed_ms: Date.now() - started,
          ...(url ? { expected_url: url } : {}),
          ...(includes ? { includes } : {}),
          ...(rawRegex ? { regex: rawRegex } : {}),
        };
      }
      if (Date.now() >= deadline) {
        throw Error("timed out waiting for URL match");
      }
      await sleepMs(Math.max(20, poll_ms));
    }
  }

  if (action.name === "wait_for_selector") {
    const selector = `${action.selector ?? ""}`.trim();
    if (!selector) {
      throw Error("selector must be specified");
    }
    const state = action.state ?? "visible";
    const timeout_ms = asFinitePositive(action.timeout_ms) ?? 30_000;
    const poll_ms = asFinitePositive(action.poll_ms) ?? 100;
    const { element } = await waitForSelectorState({
      selector,
      state,
      timeout_ms,
      poll_ms,
    });
    return {
      name: "wait_for_selector",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      selector,
      state,
      matched: !!element,
    };
  }

  if (action.name === "click") {
    const selector = `${action.selector ?? ""}`.trim();
    if (!selector) {
      throw Error("selector must be specified");
    }
    const button = action.button ?? "left";
    if (!["left", "middle", "right"].includes(button)) {
      throw Error("button must be one of left|middle|right");
    }
    const timeout_ms = asFinitePositive(action.timeout_ms) ?? 30_000;
    const click_count = Math.max(
      1,
      Math.floor(asFinitePositive(action.click_count) ?? 1),
    );
    const wait_for_navigation_ms =
      asFiniteNonNegative(action.wait_for_navigation_ms) ?? 0;
    const before = `${location.href ?? ""}`;
    const { element } = await waitForSelectorState({
      selector,
      // Terminals (e.g. xterm helper textarea) are intentionally hidden but
      // still type targets. Requiring "visible" makes type actions time out.
      state: "attached",
      timeout_ms,
      poll_ms: 50,
    });
    if (!element) {
      throw Error(`selector '${selector}' not found`);
    }
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ block: "center", inline: "center" });
    }
    const rect = element.getBoundingClientRect();
    const center = {
      clientX: Number(rect.left || 0) + Number(rect.width || 0) / 2,
      clientY: Number(rect.top || 0) + Number(rect.height || 0) / 2,
    };
    for (let i = 0; i < click_count; i++) {
      dispatchClickAtPoint({
        clientX: center.clientX,
        clientY: center.clientY,
        button,
        clickIndex: i,
      });
    }
    let navigation_changed = false;
    if (wait_for_navigation_ms > 0) {
      const navDeadline = Date.now() + wait_for_navigation_ms;
      for (;;) {
        const href = `${location.href ?? ""}`;
        if (href !== before) {
          navigation_changed = true;
          break;
        }
        if (Date.now() >= navDeadline) break;
        await sleepMs(50);
      }
    }
    return {
      name: "click",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      selector,
      button,
      click_count,
      click_point: center,
      navigation_changed,
      before_url: before,
    };
  }

  if (action.name === "click_at") {
    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw Error("click_at requires finite x and y coordinates");
    }
    const button = action.button ?? "left";
    if (!["left", "middle", "right"].includes(button)) {
      throw Error("button must be one of left|middle|right");
    }
    const click_count = Math.max(
      1,
      Math.floor(asFinitePositive(action.click_count) ?? 1),
    );
    const timeout_ms = asFinitePositive(action.timeout_ms) ?? 30_000;
    const wait_for_navigation_ms =
      asFiniteNonNegative(action.wait_for_navigation_ms) ?? 0;
    const space = (action.space ?? "viewport") as BrowserCoordinateSpace;
    const before = `${location.href ?? ""}`;
    const point = await resolveCoordinatePoint({
      x,
      y,
      space,
      selector: action.selector,
      timeout_ms,
      screenshot_meta: action.screenshot_meta,
      strict_meta: !!action.strict_meta,
    });
    for (let i = 0; i < click_count; i++) {
      dispatchClickAtPoint({
        clientX: point.clientX,
        clientY: point.clientY,
        button,
        clickIndex: i,
      });
    }
    let navigation_changed = false;
    if (wait_for_navigation_ms > 0) {
      const navDeadline = Date.now() + wait_for_navigation_ms;
      for (;;) {
        const href = `${location.href ?? ""}`;
        if (href !== before) {
          navigation_changed = true;
          break;
        }
        if (Date.now() >= navDeadline) break;
        await sleepMs(50);
      }
    }
    const hit = targetAtPoint(point.clientX, point.clientY);
    return {
      name: "click_at",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      input: { x, y, space },
      resolved_point: { x: point.clientX, y: point.clientY },
      ...(point.selector_used ? { selector: point.selector_used } : {}),
      ...(point.meta_rect_drift ? { meta_rect_drift: point.meta_rect_drift } : {}),
      hit_tag: hit.tagName?.toLowerCase?.() ?? "",
      button,
      click_count,
      navigation_changed,
      before_url: before,
    };
  }

  if (action.name === "drag") {
    const x1 = Number(action.x1);
    const y1 = Number(action.y1);
    const x2 = Number(action.x2);
    const y2 = Number(action.y2);
    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      throw Error("drag requires finite x1,y1,x2,y2 coordinates");
    }
    const button = action.button ?? "left";
    if (!["left", "middle", "right"].includes(button)) {
      throw Error("button must be one of left|middle|right");
    }
    const timeout_ms = asFinitePositive(action.timeout_ms) ?? 30_000;
    const hold_ms = asFiniteNonNegative(action.hold_ms) ?? 0;
    const steps = Math.max(1, Math.floor(asFinitePositive(action.steps) ?? 14));
    const space = (action.space ?? "viewport") as BrowserCoordinateSpace;
    const startPoint = await resolveCoordinatePoint({
      x: x1,
      y: y1,
      space,
      selector: action.selector,
      timeout_ms,
      screenshot_meta: action.screenshot_meta,
      strict_meta: !!action.strict_meta,
    });
    const endPoint = await resolveCoordinatePoint({
      x: x2,
      y: y2,
      space,
      selector: action.selector,
      timeout_ms,
      screenshot_meta: action.screenshot_meta,
      strict_meta: !!action.strict_meta,
    });
    await dispatchDrag({
      start: { clientX: startPoint.clientX, clientY: startPoint.clientY },
      end: { clientX: endPoint.clientX, clientY: endPoint.clientY },
      button,
      steps,
      hold_ms,
    });
    return {
      name: "drag",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      input: { x1, y1, x2, y2, space },
      start_point: { x: startPoint.clientX, y: startPoint.clientY },
      end_point: { x: endPoint.clientX, y: endPoint.clientY },
      ...(startPoint.selector_used ? { selector: startPoint.selector_used } : {}),
      ...(startPoint.meta_rect_drift ? { meta_rect_drift_start: startPoint.meta_rect_drift } : {}),
      ...(endPoint.meta_rect_drift ? { meta_rect_drift_end: endPoint.meta_rect_drift } : {}),
      button,
      steps,
      hold_ms,
    };
  }

  if (action.name === "type") {
    const selector = `${action.selector ?? ""}`.trim();
    if (!selector) {
      throw Error("selector must be specified");
    }
    const text = `${action.text ?? ""}`;
    const timeout_ms = asFinitePositive(action.timeout_ms) ?? 30_000;
    const append = !!action.append && !action.clear;
    const clear = !!action.clear;
    const { element } = await waitForSelectorState({
      selector,
      // Some valid typing targets (notably xterm helper textarea) are hidden by
      // design. "attached" keeps terminal automation working.
      state: "attached",
      timeout_ms,
      poll_ms: 50,
    });
    if (!element) {
      throw Error(`selector '${selector}' not found`);
    }
    if (element instanceof HTMLElement) {
      element.focus();
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      if (clear) {
        element.value = "";
      }
      element.value = append ? `${element.value}${text}` : text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof element.setSelectionRange === "function") {
        const pos = element.value.length;
        element.setSelectionRange(pos, pos);
      }
    } else if ((element as HTMLElement).isContentEditable) {
      const editable = element as HTMLElement;
      if (clear || !append) {
        editable.textContent = "";
      }
      editable.textContent = `${editable.textContent ?? ""}${text}`;
      editable.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      throw Error(
        `selector '${selector}' does not target a typeable input/textarea/contenteditable element`,
      );
    }
    if (action.submit && element instanceof HTMLElement) {
      const form = element.closest("form") as HTMLFormElement | null;
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else if (form) {
        form.submit();
      }
    }
    return {
      name: "type",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      selector,
      chars: text.length,
      append,
      clear,
      submitted: !!action.submit,
    };
  }

  if (action.name === "press") {
    const key = `${action.key ?? ""}`.trim();
    if (!key) {
      throw Error("key must be specified");
    }
    const timeout_ms = asFinitePositive(action.timeout_ms) ?? 30_000;
    const selector = `${action.selector ?? ""}`.trim();
    let target: Element | null = null;
    if (selector) {
      const found = await waitForSelectorState({
        selector,
        state: "visible",
        timeout_ms,
        poll_ms: 50,
      });
      target = found.element;
    } else {
      target = (document.activeElement as Element | null) ?? document.body;
    }
    if (!target) {
      throw Error("unable to determine target for key press");
    }
    if (target instanceof HTMLElement) {
      target.focus();
    }
    const init: KeyboardEventInit = {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: !!action.ctrl,
      altKey: !!action.alt,
      shiftKey: !!action.shift,
      metaKey: !!action.meta,
    };
    const keyDown = new KeyboardEvent("keydown", init);
    const proceed = target.dispatchEvent(keyDown);
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    if (proceed && key === "Enter" && target instanceof HTMLElement) {
      const form = target.closest("form") as HTMLFormElement | null;
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
      }
    }
    return {
      name: "press",
      ok: true,
      page_url: location.href,
      elapsed_ms: Date.now() - started,
      key,
      ...(selector ? { selector } : {}),
      ctrl: !!action.ctrl,
      alt: !!action.alt,
      shift: !!action.shift,
      meta: !!action.meta,
    };
  }

  throw Error(`unsupported browser action '${(action as any).name ?? ""}'`);
}
