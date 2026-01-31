"use strict";

const ReactDOM = require("react-dom");

// React 19 removes findDOMNode; @ant-design/compatible still calls it.
// Provide a no-op fallback to avoid build-time export warnings.
if (typeof ReactDOM.findDOMNode !== "function") {
  ReactDOM.findDOMNode = () => null;
}

module.exports = ReactDOM;
