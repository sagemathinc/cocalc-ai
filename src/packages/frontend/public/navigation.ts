/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getPublicRedirectPath, isPublicTarget } from "./routes";

type PublicNavigationListener = (pathname: string, search: string) => void;

let listener: PublicNavigationListener | undefined;

function isPlainLeftClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey
  );
}

function shouldIntercept(
  anchor: HTMLAnchorElement,
  event: MouseEvent,
): boolean {
  if (!isPlainLeftClick(event)) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  return true;
}

function getInternalPublicUrl(href: string): URL | undefined {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) return;
  const target = `${url.pathname}${url.search}`;
  if (!isPublicTarget(target)) return;
  return url;
}

// Fragment links within the current page (href="#section", or a full URL
// that differs only in its hash) must reach the browser's native fragment
// navigation: intercepting them would push the hash into history without
// ever scrolling to the target.
function isSamePageFragmentNavigation(url: URL): boolean {
  return (
    !!url.hash &&
    url.pathname === window.location.pathname &&
    url.search === window.location.search
  );
}

function notify(url: URL): void {
  listener?.(url.pathname, url.search);
}

export function setPublicNavigationListener(
  next?: PublicNavigationListener,
): void {
  listener = next;
}

export function navigatePublic(href: string, replace = false): void {
  const url = getInternalPublicUrl(href);
  if (url == null) {
    window.location.assign(href);
    return;
  }
  // Follow a permanent redirect before the address enters the history, as
  // the browser would for a full page load.
  const redirectPath = getPublicRedirectPath(url.pathname);
  if (redirectPath != null) {
    url.pathname = redirectPath;
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (replace) {
    window.history.replaceState({}, "", next);
  } else {
    window.history.pushState({}, "", next);
  }
  notify(url);
}

export function attachPublicNavigationInterceptor(): () => void {
  function onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!shouldIntercept(anchor, event)) return;
    const url = getInternalPublicUrl(anchor.href);
    if (url == null || isSamePageFragmentNavigation(url)) return;
    event.preventDefault();
    navigatePublic(anchor.href);
  }

  document.addEventListener("click", onClick);
  return () => {
    document.removeEventListener("click", onClick);
  };
}
