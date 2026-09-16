import { useEffect, useRef, useState } from "react";
import useResizeObserver from "use-resize-observer";
import { Spin } from "antd";

export default function Plot(props) {
  const divRef = useRef<HTMLDivElement>(null as any);
  const resize = useResizeObserver({ ref: divRef });
  const [PlotlyComponent, setPlotlyComponent] = useState<any>(null);

  useEffect(() => {
    (async () => {
      // load only when actually used, since this involves dynamic load over the internet,
      // and we don't want loading cocalc in an airgapped network to have hung network requests,
      // and this Plot functionality is only used very little.
      const [{ default: createPlotlyComponent }, { default: Plotly }] =
        await Promise.all([
          import("react-plotly.js/factory"),
          import("plotly.js"),
        ]);
      const Component = createPlotlyComponent(Plotly);
      setPlotlyComponent(() => Component);
    })();
  }, []);

  return (
    <div ref={divRef} style={props.style}>
      {PlotlyComponent != null ? (
        <PlotlyComponent
          {...props}
          layout={{ ...props.layout, width: resize.width }}
        />
      ) : (
        <Spin />
      )}
    </div>
  );
}
