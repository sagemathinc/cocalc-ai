/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert } from "antd";
import type { JSX } from "react";
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
import type { KernelSpec } from "@cocalc/jupyter/ipynb/parse";

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
          message="Output is hidden in this notebook."
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
    return renderData(message.data, kernelspec);
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

function renderData(
  data: { [key: string]: any },
  kernelspec?: KernelSpec,
): JSX.Element {
  const type = getTypeToRender(data, kernelspec);
  const value = data?.[type];

  switch (type) {
    case "application/pdf":
      return renderPdf(value);

    case "text/html":
    case "iframe":
      return renderHtml(value);

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

function renderHtml(value: unknown): JSX.Element {
  const content = `${value ?? ""}`;
  return (
    // Public notebook viewers render on a dedicated raw subdomain with no
    // authenticated CoCalc state, so we intentionally avoid sanitization and
    // iframe sandboxing here in order to preserve notebook HTML behavior.
    <div
      className="cocalc-jupyter-rendered"
      dangerouslySetInnerHTML={{ __html: content }}
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
      alt="Image in a Jupyter notebook"
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
