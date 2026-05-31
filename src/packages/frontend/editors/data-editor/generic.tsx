/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Editor" (really a read-only simple viewer) for generic data files
//
// See https://github.com/sagemathinc/cocalc/issues/2462

import { React, Rendered, useActions } from "@cocalc/frontend/app-framework";
import { register_file_editor } from "@cocalc/frontend/project-file";
import { Markdown } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { keys, filename_extension } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { Button, Well } from "@cocalc/frontend/antd-bootstrap";

const hdf_file =
  "Hierarchical Data Format (HDF file) -- you can open this file using a Python or R library.";
const excel =
  "Microsoft Excel file -- download it for spreadsheet editing, or convert it to CSV/XLSX locally and upload the result.";
const microsoft_word =
  "Microsoft Word file -- download it for document editing, or convert it to PDF/Markdown locally and upload the result.";
const microsoft_ppt =
  "Microsoft PowerPoint -- download it for presentation editing, or export slides locally and upload the result.";
const windows_executable =
  "Windows Executable -- you must download this program and run it on a computer";
const python_pickle =
  "Python Pickle -- use Python's [pickle module](https://docs.python.org/3/library/pickle.html) to read this file.s";
const medical_imaging =
  "This is a medical image file.  You cannot open it directly in CoCalc, but you might be able to use it from a Python library.";

// ext: markdown string.
const INFO = {
  p: python_pickle,
  pkl: python_pickle,
  pickle: python_pickle,
  exe: windows_executable,
  h4: hdf_file,
  h5: hdf_file,
  xlsx: excel,
  xls: excel,
  doc: microsoft_word,
  docx: microsoft_word,
  ppt: microsoft_ppt,
  pptx: microsoft_ppt,
  blend:
    "This is a [Blender](https://www.blender.org/) file. Download it and open it in Blender on a desktop machine.",
  kmz: "Editing [KMZ files](https://developers.google.com/kml/documentation/kmzarchives) is not supported. You could `unzip` them in a [Terminal](/app-docs/terminal/use-terminal).",
  jar: "Run JAVA jar archives in a [Terminal](/app-docs/terminal/use-terminal) via `java -jar <filename.jar>`",
  raw: "You may be able to use this file via a Python library or use it in some other way.",
  tiff: 'You may be able to use this file via a Python image manipulation library, or download it and edit it with a desktop tool like "Gimp".',
  fit: "You may be able to use this file from Python using the [fitparse](https://github.com/dtcooper/python-fitparse) library.",
  odt: "OpenDocument Text -- download it for document editing, or convert it to PDF/Markdown locally and upload the result.",
  ods: "OpenDocument Spreadsheet -- download it for spreadsheet editing, or convert it to CSV/XLSX locally and upload the result.",
  odp: "OpenDocument Presentation -- download it for presentation editing, or export slides locally and upload the result.",
  sobj: 'You can load an sobj file into **SageMath** by typing `load("filename.sobj")`.',
  "noext-octave-workspace": `\
This is a data file that contains the state of your Octave workspace.
Read more: [Saving-Data-on-Unexpected-Exits](https://www.gnu.org/software/octave/doc/v4.2.1/Saving-Data-on-Unexpected-Exits.html).\
`,
  "noext-a.out":
    "This is a binary executable, which you can run in a Terminal by typing ./a.out.",
  dcm: medical_imaging,
  fif: medical_imaging,
  nii: medical_imaging,
} as const;

interface Props {
  project_id: string;
  path: string;
}

const DataGeneric: React.FC<Props> = React.memo((props: Props) => {
  const { project_id, path } = props;
  const ext = filename_extension(path);
  const src = webapp_client.project_client.read_file({ project_id, path });
  const project_actions = useActions({ project_id });

  function render_hint(): Rendered {
    const hint = INFO[ext];
    if (hint) {
      return <Markdown value={`**Hint**: ${hint}`} />;
    }
    return (
      <span style={{ color: COLORS.GRAY }}>
        You may be able to use this file from another program, for example, as a
        data file that is manipulated using a Jupyter notebook.
      </span>
    );
  }

  function render_docx() {
    if (ext !== "docx") return;
    return (
      <>
        <br />
        <div>
          It is possible to{" "}
          <Button onClick={() => project_actions?.open_word_document(path)}>
            convert this file to markdown
          </Button>{" "}
          .
        </div>
      </>
    );
  }

  return (
    <Well style={{ margin: "15px", fontSize: "12pt" }}>
      <h2>Data File</h2>
      CoCalc does not have a special viewer or editor for{" "}
      <a href={src} target="_blank">
        {path}
      </a>
      .{render_docx()}
      <br />
      <br />
      {render_hint()}
    </Well>
  );
});

register_file_editor({
  ext: keys(INFO),
  icon: "question-circle",
  component: DataGeneric,
});
