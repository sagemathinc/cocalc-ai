"use strict";

// Jest-side stub for CodeMirror init to avoid loading ESM-only modes/addons.
if (typeof global !== "undefined" && !global.CodeMirror) {
  global.CodeMirror = {};
}

module.exports = {};
