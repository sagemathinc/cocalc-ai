const React = require("react");

function ImgCrop(props) {
  return React.createElement(React.Fragment, null, props?.children ?? null);
}

module.exports = ImgCrop;
module.exports.default = ImgCrop;
