/*
HTML output in the nbviewer: as in the notebook (see ../html-output.tsx), so,
e.g., plotly plots, which are NOT embedded in an iframe, still just work.
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
