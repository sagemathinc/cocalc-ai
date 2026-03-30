import jQuery from "jquery";
// This is assumed in some of the ancient libraries we're still loading:
(window as any).$ = (window as any).jQuery = jQuery;

// node.js polyfill -- needed for some modules to load in the browser.
import { Buffer } from "buffer";
(window as any).Buffer = Buffer;

// this must come before anything that touches event handling, etc.
import "./webapp-error-reporter";

// jQuery plugins
// this is a require since it must happen after window.jQuery above (and imports happen before code).
import "jquery-tooltip/jquery.tooltip";

// Timeago jQuery plugin
import "timeago";

// Scroll into view plugin
import "jquery.scrollintoview/jquery.scrollintoview";

// XTerm terminal emulator
import "script-loader!@cocalc/assets/term/term.js";
import "script-loader!@cocalc/assets/term/color_themes.js";

import "@cocalc/frontend/set-version-cookie.js";

import "./webapp-css";

// SASS style file for CoCalc.  This must be at
// the very end, and by using a dynamic import, it
// is imported in another chunk, hence after antd.
// That's important so this overrides antd.
// @ts-ignore -- handled by webpack but not typescirpt.
import("@cocalc/frontend/index.sass"); // this is a dynamic import on purpose!
