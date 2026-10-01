const React = require("react");

// Directory integration tests exercise cursor/state behavior without layout.
// The real virtual window is covered separately and in browser verification.
function List({ data, itemContent, computeItemKey }) {
  return React.createElement(
    "div",
    null,
    data.map((item, index) =>
      React.createElement(
        "div",
        { key: computeItemKey(index, item) },
        itemContent(index, item),
      ),
    ),
  );
}
module.exports = { Virtuoso: List, VirtuosoGrid: List };
