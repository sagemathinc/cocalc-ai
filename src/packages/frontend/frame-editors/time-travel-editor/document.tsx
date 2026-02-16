/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Render a static version of a document for use in TimeTravel.
*/

import { fromJS } from "immutable";
import {
  CodemirrorEditor,
  type Props as CodemirrorEditorProps,
} from "../code-editor/codemirror-editor";

function withExtension(path: string, ext: string): string {
  const normalized = ext.startsWith(".") ? ext.slice(1) : ext;
  if (!normalized) return path;
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const hasExt = base.lastIndexOf(".") > 0;
  if (hasExt) {
    return path.replace(/\.([^.\/]+)$/, `.${normalized}`);
  }
  return `${path}.${normalized}`;
}

type TextDocumentProps = Pick<
  CodemirrorEditorProps,
  "id" | "actions" | "path" | "project_id" | "font_size" | "editor_settings"
> & {
  value: string | (() => string);
  syntaxHighlightExtension?: string;
};

export function TextDocument(props: TextDocumentProps) {
  const {
    id,
    actions,
    path,
    project_id,
    font_size,
    editor_settings,
    value,
    syntaxHighlightExtension,
  } = props;
  const modePath =
    syntaxHighlightExtension != null
      ? withExtension(path, syntaxHighlightExtension)
      : undefined;
  return (
    <div className="smc-vfill" style={{ overflowY: "auto" }}>
      <CodemirrorEditor
        id={id}
        actions={actions}
        path={path}
        project_id={project_id}
        font_size={font_size}
        editor_settings={editor_settings}
        value={value}
        mode_path={modePath}
        cursors={fromJS({})}
        editor_state={fromJS({})}
        read_only={true}
        is_current={true}
        misspelled_words={fromJS([]) as any}
        resize={0}
        gutters={[]}
        gutter_markers={fromJS({}) as any}
      />
    </div>
  );
}
