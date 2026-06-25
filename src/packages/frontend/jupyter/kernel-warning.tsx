/*
Use the antd alert component to display a warning when it is a nonempty string.
*/

import { Alert } from "antd";
import { useRedux } from "@cocalc/frontend/app-framework";
import { DocsLink } from "@cocalc/frontend/docs/link";
import type { JupyterActions } from "./browser-actions";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { useEffect } from "react";

interface Props {
  name: string; // redux name
  actions: JupyterActions;
}

export default function KernelWarning({ name, actions }: Props) {
  let kernelError: undefined | string = useRedux([name, "kernel_error"]);
  const projectId: string | undefined =
    useRedux([name, "project_id"]) ?? actions.project_id;
  if (kernelError) {
    const i = kernelError.indexOf("[IPKernelApp]");
    if (i != -1) {
      kernelError = kernelError.slice(0, i);
    }
  }

  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const visible = kernelError != null && kernelError !== "";
    el.setAttribute(
      "data-cocalc-jupyter-kernel-warning-visible",
      visible ? "1" : "0",
    );
    el.setAttribute(
      "data-cocalc-jupyter-kernel-warning-text",
      kernelError ?? "",
    );
  }, [kernelError]);

  if (!kernelError) {
    return null;
  }
  return (
    <div cocalc-test="kernel-warning">
      <Alert
        banner
        title={
          <div>
            <DocsLink
              projectId={projectId}
              slug="troubleshooting/jupyter-kernel-terminated"
              style={{ float: "right", marginLeft: "10px" }}
            >
              Docs...
            </DocsLink>
            <StaticMarkdown value={kernelError} />
          </div>
        }
        type="warning"
        closable
        onClose={() => {
          actions.set_kernel_error("");
        }}
      />
    </div>
  );
}
