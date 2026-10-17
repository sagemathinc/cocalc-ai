/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert } from "antd";
import { createContext, useContext, type JSX } from "react";
import HTML from "@cocalc/frontend/components/html-ssr";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown-public";
import {
  Ansi,
  is_ansi as isAnsi,
} from "@cocalc/frontend/jupyter/output-messages/ansi";
import {
  OUT_STYLE,
  OUTPUT_STYLE,
  STDERR_STYLE,
  STDOUT_STYLE,
  TRACEBACK_STYLE,
} from "@cocalc/frontend/jupyter/output-messages/style";
import AutosizedIframe from "@cocalc/frontend/jupyter/output-messages/autosized-iframe";
import type { KernelSpec } from "@cocalc/jupyter/ipynb/parse";

/*
How HTML output is shown in the public viewer.  No viewer ever chose to trust
a public notebook, so by default its HTML is passive: sanitized by the central
renderer, with no scripts.  The viewer can switch the page to interactive
output, which runs each HTML output in its own opaque sandboxed iframe
(scripts, but no access to this page, its origin, or other outputs).
*/
export const PublicOutputModeContext = createContext<{ interactive: boolean }>({
  interactive: false,
});

// The only sandbox for active public output: scripts in an opaque origin.
const INTERACTIVE_SANDBOX = "allow-scripts";

interface Props {
  cell: { [key: string]: any };
  kernelspec?: KernelSpec;
}

export default function PublicCellOutput({
  cell,
  kernelspec,
}: Props): JSX.Element | null {
  if (cell?.metadata?.jupyter?.outputs_hidden) {
    return (
      <div style={{ marginLeft: "7em", marginTop: "4px" }}>
        <Alert
          type="info"
          showIcon
          title="Output is hidden in this notebook."
        />
      </div>
    );
  }

  const messages = getMessages(cell?.output);
  if (messages.length === 0) {
    return null;
  }

  const execCount = getExecCount(cell, messages);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
      }}
      cocalc-test="public-cell-output"
    >
      <div style={PUBLIC_OUTPUT_PROMPT_STYLE}>
        {execCount == null ? "" : `Out[${execCount}]:`}
      </div>
      <div style={OUTPUT_STYLE}>
        {messages.map((message, i) => (
          <PublicOutputMessage
            key={i}
            kernelspec={kernelspec}
            message={message}
          />
        ))}
      </div>
    </div>
  );
}

function PublicOutputMessage({
  message,
  kernelspec,
}: {
  message: { [key: string]: any };
  kernelspec?: KernelSpec;
}): JSX.Element | null {
  if (message?.more_output != null) {
    return (
      <div style={{ marginTop: "5px" }}>
        Additional output is not available in the public viewer.
      </div>
    );
  }

  if (message?.name === "stdout") {
    return <StreamOutput style={STDOUT_STYLE} text={message.text} />;
  }
  if (message?.name === "stderr") {
    return <StreamOutput style={STDERR_STYLE} text={message.text} />;
  }
  if (message?.name === "input" && message?.value != null) {
    return (
      <div style={STDOUT_STYLE}>
        {message?.opts?.prompt ?? ""}
        <input
          readOnly
          size={Math.max(47, `${message.value}`.length + 10)}
          style={{ padding: "0em 0.25em", margin: "0em 0.25em" }}
          type={message?.opts?.password ? "password" : "text"}
          value={`${message.value ?? ""}`}
        />
      </div>
    );
  }
  if (message?.traceback != null) {
    return <TracebackOutput traceback={message.traceback} />;
  }
  if (message?.data != null) {
    return <RenderData data={message.data} kernelspec={kernelspec} />;
  }
  if (message?.output_type === "display_data") {
    return null;
  }

  return (
    <pre style={STDERR_STYLE}>{JSON.stringify(message, undefined, 2)}</pre>
  );
}

function StreamOutput({
  text,
  style,
}: {
  text: unknown;
  style: React.CSSProperties;
}): JSX.Element {
  const value = typeof text === "string" ? text : `${text ?? ""}`;
  if (isAnsi(value)) {
    return (
      <div style={style}>
        <Ansi>{value}</Ansi>
      </div>
    );
  }
  return (
    <div style={style}>
      <span>{value}</span>
    </div>
  );
}

function TracebackOutput({ traceback }: { traceback: unknown }): JSX.Element {
  const lines =
    typeof traceback === "string"
      ? traceback.split("\n")
      : Array.isArray(traceback)
        ? traceback
        : [JSON.stringify(traceback)];

  return (
    <div style={TRACEBACK_STYLE}>
      {lines.map((line, i) => {
        const text = `${line ?? ""}${`${line ?? ""}`.endsWith("\n") ? "" : "\n"}`;
        return <Ansi key={i}>{text}</Ansi>;
      })}
    </div>
  );
}

function RenderData({
  data,
  kernelspec,
}: {
  data: { [key: string]: any };
  kernelspec?: KernelSpec;
}): JSX.Element {
  const { interactive } = useContext(PublicOutputModeContext);
  let type = getTypeToRender(data, kernelspec);
  if (!interactive && (type === "text/html" || type === "iframe")) {
    // Passive mode: HTML that needs scripts (e.g., Plotly) would be blank, so
    // prefer a static image of the same output when there is one.
    const image = Object.keys(data).find((t) => t.startsWith("image/"));
    if (image != null && /<script\b/i.test(`${data[type] ?? ""}`)) {
      type = image;
    }
  }
  const value = data?.[type];

  switch (type) {
    case "application/pdf":
      return renderPdf(value);

    case "text/html":
    case "iframe":
      return interactive ? (
        <InteractiveHtml value={value} />
      ) : (
        <PassiveHtml value={value} />
      );

    case "text/markdown":
    case "text/latex":
      return (
        <div style={{ margin: "5px 0" }}>
          <StaticMarkdown value={`${value ?? ""}`} />
        </div>
      );

    case "application/json":
      return <pre style={OUT_STYLE}>{JSON.stringify(value, undefined, 2)}</pre>;

    case "text/plain":
      return <StreamOutput style={STDOUT_STYLE} text={value} />;

    default:
      if (type.startsWith("image/")) {
        return renderImage(type, value);
      }
      return (
        <pre style={OUT_STYLE}>
          {JSON.stringify({ type, value }, undefined, 2)}
        </pre>
      );
  }
}

function getTypeToRender(
  data: { [key: string]: any },
  kernelspec?: KernelSpec,
): string {
  const types = Object.keys(data ?? {});
  const language = kernelspec?.language?.toLowerCase();

  if (
    language?.startsWith("sage") &&
    (types.includes("text/html") || types.includes("iframe")) &&
    types.includes("text/latex")
  ) {
    return "text/latex";
  }

  const ranked = types
    .map((type) => ({ type, priority: getPriority(type) }))
    .filter(({ priority }) => priority > 0)
    .sort((a, b) => b.priority - a.priority);

  return ranked[0]?.type ?? types[0] ?? "text/plain";
}

function getPriority(type: string): number {
  if (type === "application/pdf") return 6;
  if (type === "text/html" || type === "iframe") return 5;
  if (type === "text/markdown") return 4;
  if (type === "text/latex") return 3.5;
  if (type.startsWith("image/")) return 2;
  if (type === "application/json") return 1.5;
  if (type === "text/plain") return 1;
  return 0;
}

function PassiveHtml({ value }: { value: unknown }): JSX.Element {
  return (
    <div className="cocalc-jupyter-rendered" style={{ overflowX: "auto" }}>
      <FileContext.Provider value={{ noSanitize: false }}>
        <HTML value={`${value ?? ""}`} />
      </FileContext.Provider>
    </div>
  );
}

function InteractiveHtml({ value }: { value: unknown }): JSX.Element {
  return (
    <AutosizedIframe
      srcDoc={`${value ?? ""}`}
      sandbox={INTERACTIVE_SANDBOX}
      title="Jupyter HTML output"
    />
  );
}

function renderPdf(value: unknown): JSX.Element {
  const content =
    typeof value === "string"
      ? value
      : `${(value as any)?.value ?? value ?? ""}`;
  return (
    <embed
      src={`data:application/pdf;base64,${content}`}
      style={{ width: "100%", height: "70vh" }}
      type="application/pdf"
    />
  );
}

function renderImage(type: string, value: unknown): JSX.Element {
  const content =
    typeof value === "string"
      ? value
      : `${(value as any)?.value ?? value ?? ""}`;
  if (!content) {
    return <span>[unavailable image]</span>;
  }
  const encoding = type === "image/svg+xml" ? "utf8" : "base64";
  const src = `data:${type};${encoding},${encodeURIComponent(content)}`;
  return (
    <img
      alt="Jupyter output"
      src={src}
      style={{ maxWidth: "100%", height: "auto" }}
    />
  );
}

function getMessages(output: { [key: string]: any } | null | undefined): any[] {
  if (output == null) {
    return [];
  }
  return Object.keys(output)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => output[key])
    .filter((message) => message != null);
}

function getExecCount(
  cell: { [key: string]: any },
  messages: any[],
): number | null | undefined {
  let execCount = cell?.exec_count;
  for (const message of messages) {
    if (message?.exec_count != null) {
      execCount = message.exec_count;
      break;
    }
  }
  return execCount;
}

const PUBLIC_OUTPUT_PROMPT_STYLE: React.CSSProperties = {
  color: "#D84315",
  minWidth: "7em",
  fontFamily: "monospace",
  textAlign: "right",
  paddingRight: "5px",
  paddingBottom: "2px",
};
