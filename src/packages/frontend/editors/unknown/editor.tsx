/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { React, useActions, useTypedRedux, CSS } from "../../app-framework";
import { delay } from "awaiting";
import { webapp_client } from "../../webapp-client";
import { Button, Alert, Typography, Row, Col } from "antd";
const { Text } = Typography;
import { register_file_editor } from "../../frame-editors/frame-tree/register";
import { filename_extension_notilde, path_split } from "@cocalc/util/misc";
import type { ExecOutput } from "@cocalc/util/db-schema/projects";
import { Loading } from "../../components";
import { Editor as CodeEditor } from "../../frame-editors/code-editor/editor";
import { Actions as CodeEditorActions } from "../../frame-editors/code-editor/actions";

const STYLE: CSS = {
  margin: "0 auto",
  padding: "20px",
  maxWidth: "1000px",
};

interface Props {
  path: string;
  project_id: string;
}

function isMissingCommandFailure(stderr?: string): boolean {
  const text = `${stderr ?? ""}`.toLowerCase();
  return (
    text.includes("enoent") ||
    text.includes("not found") ||
    text.includes("command not found")
  );
}

function normalizeTextSnippet(raw: string): string {
  return raw
    .trim()
    .slice(0, 20 * 80)
    .split(/(.{0,80})/g)
    .filter((x) => !!x)
    .join("");
}

function looksLikeTextPreview(raw: string): boolean {
  if (!raw) return true;
  let suspicious = 0;
  let total = 0;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    total += 1;
    if (code === 0) {
      return false;
    }
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      suspicious += 1;
    }
  }
  return suspicious / Math.max(total, 1) < 0.1;
}

function previewMimeFromContent(mime: string, raw: string): string {
  if (mime) {
    return mime;
  }
  return looksLikeTextPreview(raw) ? "text/plain" : "application/octet-stream";
}

function parseMime(raw: string): string {
  return raw.split("\n")[0].trim();
}

function formatExecError(
  label: string,
  resp: Pick<ExecOutput, "exit_code" | "stderr">,
): string {
  const stderr = `${resp.stderr ?? ""}`.trim();
  if (!stderr) {
    return `Error: ${label} probe exited with code ${resp.exit_code}`;
  }
  return `Error: ${label} probe exited with code ${resp.exit_code} -- ${stderr}`;
}

async function get_mime({ project_id, path, set_mime, set_err, set_snippet }) {
  try {
    let mime = "";
    const mimeProbe = await webapp_client.project_client.exec({
      project_id,
      command: "file",
      args: ["-b", "--mime-type", path],
      filesystem: true,
    });
    if (mimeProbe.exit_code === 0) {
      mime = parseMime(mimeProbe.stdout);
      set_mime(mime);
    }

    // limit number of bytes – it could be a "one-line" monster file.
    // We *ONLY* limit by number of bytes, because limiting by both
    // bytes and lines isn't supported in POSIX (e.g., macos), even though
    // it works in Linux.
    const previewProbe = await webapp_client.project_client.exec({
      project_id,
      command: "head",
      args: ["-c", "2000", path],
      filesystem: true,
    });
    if (previewProbe.exit_code !== 0) {
      if (isMissingCommandFailure(previewProbe.stderr)) {
        set_mime(mime || "application/octet-stream");
        return;
      }
      set_err(formatExecError("preview", previewProbe));
      return;
    }

    const effectiveMime = previewMimeFromContent(mime, previewProbe.stdout);
    if (!mime) {
      mime = effectiveMime;
      set_mime(mime);
    }

    if (
      effectiveMime.startsWith("text/") ||
      effectiveMime === "inode/x-empty"
    ) {
      set_snippet(normalizeTextSnippet(previewProbe.stdout));
      return;
    }

    const hexdumpProbe = await webapp_client.project_client.exec({
      project_id,
      command: "hexdump",
      args: ["-C", "-n", "512", path],
      filesystem: true,
    });
    if (hexdumpProbe.exit_code === 0) {
      set_snippet(hexdumpProbe.stdout);
      return;
    }
    if (!isMissingCommandFailure(hexdumpProbe.stderr)) {
      set_err(formatExecError("binary preview", hexdumpProbe));
    }
  } catch (err) {
    set_err(err.toString());
  }
}

export const UnknownEditor: React.FC<Props> = (props: Props) => {
  const { path, project_id } = props;
  const ext = filename_extension_notilde(path).toLowerCase();
  const NAME = useTypedRedux("customize", "site_name");
  const actions = useActions({ project_id });
  const [mime, set_mime] = React.useState("");
  const [err, set_err] = React.useState("");
  const [snippet, set_snippet] = React.useState("");

  React.useEffect(() => {
    if (mime) return;
    get_mime({ project_id, path, set_mime, set_err, set_snippet });
  }, []);

  React.useEffect(() => {
    if (actions == null) return;
    switch (mime) {
      case "inode/directory":
        (async () => {
          // It is actually a directory so we know what to do.
          // See https://github.com/sagemathinc/cocalc/issues/5212
          actions.open_directory(path);
          // We delay before closing this file, since closing the file causes a
          // state change to this component at the same time
          // as updating (which is a WARNING).
          await delay(1);
          actions.close_file(path);
        })();
        break;
      case "text/plain":
        if (ext) {
          // automatically register the code editor
          register_file_editor({
            ext: [ext],
            component: CodeEditor,
            Actions: CodeEditorActions,
          });
          (async () => {
            actions.close_file(path);
            await delay(1);
            actions.open_file({ path });
          })();
        }
        break;
    }
  }, [mime]);

  function render_ext() {
    return (
      <Text strong>
        <Text code>*.{ext}</Text>
      </Text>
    );
  }

  const explanation = React.useMemo(() => {
    if (mime == "inode/x-empty") {
      return (
        <span>
          This file is empty and has the unknown file-extension: {render_ext()}.
        </span>
      );
    } else if (mime.startsWith("text/")) {
      return (
        <span>
          This file might contain plain text, but the file-extension:{" "}
          {render_ext()}
          is unknown. Try the Code Editor!
        </span>
      );
    } else {
      return (
        <span>
          This is likely a binary file and the file-extension: {render_ext()} is
          unknown. Preferrably, you have to open this file via a library/package
          in a programming environment, like a Jupyter Notebook.
        </span>
      );
    }
  }, [mime]);

  function resolveAssociationExt(rawExt: string): string {
    const clean = `${rawExt ?? ""}`.trim().toLowerCase();
    if (clean.length > 0) {
      return clean;
    }
    return `noext-${path_split(path).tail}`.toLowerCase();
  }

  async function register(ext, editor: "code") {
    const associationExt = resolveAssociationExt(ext);
    if (actions == null) {
      console.warn(
        `Project Actions for ${project_id} not available – shouldn't happen.`,
      );
      return;
    }
    // Close first so teardown uses the current editor mapping.
    // If we register first (especially for ""), close_file teardown can route
    // through the new mapping and leave the frame in a stuck loading state.
    actions.close_file(path);
    await delay(1);

    switch (editor) {
      case "code":
        register_file_editor({
          ext: [associationExt],
          component: CodeEditor,
          Actions: CodeEditorActions,
        });
        break;
      default:
        console.warn(`Unknown editor of type ${editor}, aborting.`);
        return;
    }
    actions.open_file({ path, ext: associationExt });
  }

  function render_header() {
    return <h1>Unknown file extension</h1>;
  }

  function render_info() {
    return (
      <div>
        {NAME} does not know what to do with this file with the extension{" "}
        {render_ext()}. For this session, you can register one of the editors to
        open up this file.
      </div>
    );
  }

  function render_warning() {
    if (mime.startsWith("text/")) return;
    return (
      <Alert
        title="Warning"
        description="Opening binary files could possibly modify and hence damage them. If this happens, you can use Files → Backup to restore them."
        type="warning"
        showIcon
      />
    );
  }

  function render_register() {
    return (
      <>
        {mime && (
          <div>
            {NAME} detected that the file's content has the MIME code{" "}
            <Text strong>
              <Text code>{mime}</Text>
            </Text>
            . {explanation}
          </div>
        )}
        {!mime && <div>{NAME} was not able to detect the file's type.</div>}
        <div>The following editors are available:</div>
        <ul>
          <li>
            <Button onClick={() => register(ext, "code")}>
              Open {render_ext()} using <Text code>Code Editor</Text>
            </Button>
          </li>
        </ul>
        <div>
          <Text type="secondary">
            <Text strong>Note:</Text> by clicking this button this file will
            open immediately. This will be remembered until you open up {NAME}{" "}
            again or refresh this page. Alternatively, rename this file's file
            extension.
          </Text>
        </div>
      </>
    );
  }

  function render_content() {
    if (!snippet) return;
    return (
      <>
        <div>The content of this file starts like that:</div>
        <div>
          <pre style={{ fontSize: "70%" }}>{snippet}</pre>
        </div>
      </>
    );
  }

  function render() {
    if (!mime && !err) {
      return <Loading theme={"medium"} />;
    }
    return (
      <>
        <Col flex={1}>{render_header()}</Col>
        <Col flex={1}>{render_info()}</Col>
        <Col flex={1}>{render_warning()}</Col>
        <Col flex={1}>{render_register()}</Col>
        <Col flex={1}>{render_content()}</Col>
      </>
    );
  }

  return (
    <div style={{ overflow: "auto" }}>
      <div style={STYLE}>
        {err && <Alert type="error" title="Error" showIcon description={err} />}
        <Row gutter={[24, 24]}>{render()}</Row>
      </div>
    </div>
  );
};
