/* Test-only environment shim for Playwright runs. */

export const IS_REACT_VERSION_17_OR_ABOVE = true;

export const IS_IOS =
  typeof navigator !== "undefined" &&
  typeof window !== "undefined" &&
  /iPad|iPhone|iPod/.test(navigator.userAgent) &&
  !window["MSStream"];

export const IS_APPLE =
  typeof navigator !== "undefined" && /Mac OS X/.test(navigator.userAgent);

export const IS_ANDROID =
  typeof navigator !== "undefined" && /Android/.test(navigator.userAgent);

export const IS_FIREFOX =
  typeof navigator !== "undefined" &&
  /^(?!.*Seamonkey)(?=.*Firefox).*/i.test(navigator.userAgent);

export const IS_SAFARI =
  typeof navigator !== "undefined" &&
  /Version\/[\d\.]+.*Safari/.test(navigator.userAgent);

export const IS_EDGE_LEGACY =
  typeof navigator !== "undefined" &&
  /Edge?\/(?:[0-6][0-9]|[0-7][0-8])(?:\.)/i.test(navigator.userAgent);

export const IS_CHROME =
  typeof navigator !== "undefined" && /Chrome/i.test(navigator.userAgent);

export const IS_CHROME_LEGACY =
  typeof navigator !== "undefined" &&
  /Chrome?\/(?:[0-7][0-5]|[0-6][0-9])(?:\.)/i.test(navigator.userAgent);

export const IS_FIREFOX_LEGACY =
  typeof navigator !== "undefined" &&
  /^(?!.*Seamonkey)(?=.*Firefox\/(?:[0-7][0-9]|[0-8][0-6])(?:\.)).*/i.test(
    navigator.userAgent,
  );

export const IS_QQBROWSER =
  typeof navigator !== "undefined" && /.*QQBrowser/.test(navigator.userAgent);

export const IS_UC_MOBILE =
  typeof navigator !== "undefined" && /.*UCBrowser/.test(navigator.userAgent);

export const IS_WECHATBROWSER =
  typeof navigator !== "undefined" && /.*Wechat/.test(navigator.userAgent);

export const CAN_USE_DOM = !!(
  typeof window !== "undefined" &&
  typeof window.document !== "undefined" &&
  typeof window.document.createElement !== "undefined"
);

// Playwright doesn't emit beforeinput for Enter, so force the keydown path.
export const HAS_BEFORE_INPUT_SUPPORT = false;
