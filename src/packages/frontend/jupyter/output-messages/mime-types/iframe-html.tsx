/*
HTML output in the nbviewer takes the same path as in the notebook
(../html-output.tsx): HTML that sanitizing leaves unchanged renders inline,
sanitized; anything else, e.g. plotly plots with their scripts, renders in an
opaque sandboxed frame.
*/

import register from "./register";
import AutosizedIframe from "../autosized-iframe";
import HtmlOutput from "../html-output";

export const IframeHtml = ({ value }) => {
  let src: undefined | string = undefined;
  let srcDoc: undefined | string = undefined;
  if (
    value.startsWith("https:") ||
    value.startsWith("http:") ||
    value.startsWith("blob:")
  ) {
    src = value;
  } else {
    srcDoc = value;
  }
  return (
    <AutosizedIframe
      src={src}
      srcDoc={srcDoc}
      profile="opaque-legacy"
      title="Jupyter HTML output"
    />
  );
};

export const Html = ({ value }) => (
  <div style={{ margin: "5px 0" }}>
    <HtmlOutput value={value} />
  </div>
);

register("text/html", 5, ({ value }) => {
  return <Html value={value} />;
});
