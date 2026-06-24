/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import * as immutable from "immutable";
import { IPynbImporter } from "@cocalc/jupyter/ipynb/import-from-ipynb";
import { export_to_ipynb } from "@cocalc/jupyter/ipynb/export-to-ipynb";
import { STUDENT_SUBDIR } from "@cocalc/frontend/course/assignments/consts";
import { jupyter, labels } from "@cocalc/frontend/i18n";
import { getIntl } from "@cocalc/frontend/i18n/get-intl";
import { close, path_split } from "@cocalc/util/misc";
import { JupyterActions } from "../browser-actions";
import { clear_hidden_tests } from "./clear-hidden-tests";
import { clear_mark_regions } from "./clear-mark-regions";
import clearSolution from "./clear-solutions";
import { set_checksum } from "./compute-checksums";
import { ImmutableMetadata, Metadata } from "./types";

export class NBGraderActions {
  private jupyter_actions: JupyterActions;
  private redux;

  constructor(jupyter_actions, redux) {
    this.jupyter_actions = jupyter_actions;
    this.redux = redux;
  }

  close = (): void => {
    close(this);
  };

  // Ensure all nbgrader metadata is updated to the latest version we support.
  // The update is done as a single commit to the syncdb.
  update_metadata = (): void => {
    const cells = this.jupyter_actions.store.get("cells");
    let changed: boolean = false; // did something change.
    cells.forEach((cell, id: string): void => {
      if (cell == null) return;
      const nbgrader = cell.getIn(["metadata", "nbgrader"]) as any;
      if (nbgrader == null || nbgrader.get("schema_version") === 3) return;
      // Doing this set
      // make the actual change via the syncdb mechanism (NOT updating cells directly; instead
      // that is a side effect that happens at some point later).
      this.set_metadata(id, {}, false);
      changed = true;
    });
    if (changed) {
      this.jupyter_actions._sync();
    }
  };

  private get_metadata = (id: string): ImmutableMetadata => {
    return this.jupyter_actions.store.getIn(
      ["cells", id, "metadata", "nbgrader"],
      immutable.Map(),
    );
  };

  // Sets the metadata and also ensures the schema is properly updated.
  set_metadata = (
    id: string,
    metadata: Metadata | undefined = undefined, // if undefined, deletes the nbgrader metadata entirely
    save: boolean = true,
  ): void => {
    let nbgrader: Metadata | undefined = undefined;
    if (metadata != null) {
      nbgrader = this.get_metadata(id).toJS();
      if (nbgrader == null) throw Error("must not be null");

      // Merge in the requested changes.
      for (const k in metadata) {
        nbgrader[k] = metadata[k];
      }

      // Update the schema, if necessary:
      if (nbgrader.schema_version == null || nbgrader.schema_version < 3) {
        // The docs of the schema history are at
        //   https://nbgrader.readthedocs.io/en/stable/contributor_guide/metadata.html
        // They were not updated even after schema 3 came out, so I'm just guessing
        // based on reading source code and actual ipynb files.
        nbgrader.schema_version = 3;
        // nbgrader schema_version=3 requires that all these are set:

        // We only set "remove" if it is true. This violates the nbgrader schema, so *should*
        // break processing the ipynb file in nbgrader, which is *good* since instructors
        // won't silently push out content to students that students are not supposed to see.
        // We do NOT put nbgrader['remove']=false in explicitly, since no point in
        // breaking compatibility with official nbgrader if this cell type isn't being used.
        if (!nbgrader["remove"]) {
          delete nbgrader["remove"];
        }

        for (const k of ["grade", "locked", "solution", "task"]) {
          if (nbgrader[k] == null) {
            nbgrader[k] = false;
          }
        }
      }
    }
    this.jupyter_actions.set_cell_metadata({
      id,
      metadata: { nbgrader },
      merge: true,
      save,
    });
  };

  validate = async (frame_actions): Promise<void> => {
    // Without confirmation: (1) restart, (2) run all -- without stopping for errors.
    // Validate button should be disabled while this happens.
    // As running happens number of failing tests and total score
    // gets updated at top.
    frame_actions?.set_all_md_cells_not_editing();
    await this.jupyter_actions.restart();
    this.jupyter_actions.run_all_cells(true);
  };

  confirm_validate = async (frame_actions): Promise<void> => {
    const intl = await getIntl();
    const validate = intl.formatMessage(labels.validate);
    const choice = await this.jupyter_actions.confirm_dialog({
      title: intl.formatMessage(jupyter.commands.validate_title),
      body: intl.formatMessage(jupyter.commands.validate_body),
      choices: [
        { title: intl.formatMessage(labels.cancel) },
        { title: validate, style: "danger", default: true },
      ],
    });
    if (choice === validate) {
      await this.validate(frame_actions);
    }
  };

  confirm_assign = async (): Promise<void> => {
    const intl = await getIntl();
    const path = this.jupyter_actions.store.get("path");
    let { head, tail } = path_split(path);
    if (head == "") {
      head = `${STUDENT_SUBDIR}/`;
    } else {
      head = `${head}/${STUDENT_SUBDIR}/`;
    }
    const target = head + tail;
    let minimal_stubs = this.jupyter_actions.store.getIn(
      ["metadata", "nbgrader", "cocalc_minimal_stubs"],
      false,
    );
    const MINIMAL_STUBS = intl.formatMessage(
      jupyter.editor.nbgrader_minimal_stubs,
    );
    const title = jupyter.editor.nbgrader_create_title;
    const body = intl.formatMessage(jupyter.editor.nbgrader_create_body, {
      target,
      STUDENT_SUBDIR,
    });

    const cancel = intl.formatMessage(labels.cancel);
    const choice = await this.jupyter_actions.confirm_dialog({
      title: intl.formatMessage(title, {
        full: true,
      }),
      body,
      choices: [
        { title: cancel },
        {
          title: intl.formatMessage(title, {
            full: false,
          }),
          style: !minimal_stubs ? "primary" : undefined,
          default: !minimal_stubs,
        },
        {
          title: MINIMAL_STUBS,
          style: minimal_stubs ? "primary" : undefined,
          default: minimal_stubs,
        },
      ],
    });
    if (choice === cancel) return;
    minimal_stubs = choice == MINIMAL_STUBS;
    this.set_global_metadata({ cocalc_minimal_stubs: minimal_stubs });
    this.ensure_grade_ids_are_unique(); // non-unique ids lead to pain later
    await this.assign(target, minimal_stubs);
  };

  assign = async (
    filename: string,
    minimal_stubs: boolean = false,
  ): Promise<void> => {
    // Create a copy of the current notebook at the location specified by
    // filename, and modify by applying the assign transformations.
    const { project_id } = this.jupyter_actions;
    const project_actions = this.redux.getProjectActions(project_id);
    const studentIpynb = buildStudentVersionIpynb(
      await this.jupyter_actions.toIpynb(),
      this.jupyter_actions.store.get_kernel_language(),
      minimal_stubs,
    );
    await project_actions.ensureContainingDirectoryExists(filename);
    await project_actions
      .fs()
      .writeFile(filename, JSON.stringify(studentIpynb, undefined, 2), true);
    await project_actions.open_file({
      path: filename,
      explicit: true,
      foreground: true,
    });
  };

  // public because above we call this... on a different object!
  apply_assign_transformations = (minimal_stubs: boolean = false): void => {
    /* see https://nbgrader.readthedocs.io/en/stable/command_line_tools/nbgrader-assign.html
    Of which, we do:

        2. It locks certain cells so that they cannot be deleted by students
           accidentally (or on purpose!)

        3. It removes solutions from the notebooks and replaces them with
           code or text stubs saying (for example) "YOUR ANSWER HERE", and
           similarly for hidden tests.

        4. It clears all outputs from the cells of the notebooks.

        5. It saves information about the cell contents so that we can warn
           students if they have changed the tests, or if they have failed
           to provide a response to a written answer. Specifically, this is
           done by computing a checksum of the cell contents and saving it
           into the cell metadata.
    */
    //const log = (...args) => console.log("assign:", ...args);
    // log("unlock everything");
    this.assign_unlock_all_cells();
    // log("clear solutions");
    this.assign_clear_solutions(minimal_stubs); // step 3a
    // log("clear hidden tests");
    this.assign_clear_hidden_tests(); // step 3b
    // log("clear mark regions");
    this.assign_clear_mark_regions(); // step 3c
    // this is a nonstandard extension to nbgrader in cocalc only.
    this.assign_delete_remove_cells();
    // log("clear all outputs");
    this.jupyter_actions.clear_all_outputs(false); // step 4
    // log("assign save checksums");
    this.assign_save_checksums(); // step 5
    // log("lock readonly cells");
    this.assign_lock_readonly_cells(); // step 2 -- needs to be last, since it stops cells from being editable!
  };

  // merge in metadata to the global (not local to a cell) nbgrader
  // metadata for this notebook.  This is something I invented for
  // cocalc, and it is surely totally ignored by upstream nbgrader.
  set_global_metadata = (metadata: object): void => {
    const cur = this.jupyter_actions.store
      .getIn(["metadata", "nbgrader"])
      ?.toJS();
    if (cur) {
      metadata = {
        ...cur,
        ...metadata,
      };
    }
    this.jupyter_actions.set_global_metadata({ nbgrader: metadata });
  };

  private assign_clear_solutions = (minimal_stubs: boolean = false): void => {
    const store = this.jupyter_actions.store;
    const kernel_language = store.get_kernel_language();

    this.jupyter_actions.store.get("cells").forEach((cell) => {
      if (!cell.getIn(["metadata", "nbgrader", "solution"])) return;
      // we keep the "answer" cell of a multiple_choice question as it is
      if (cell.getIn(["metadata", "nbgrader", "multiple_choice"]) == true) {
        return;
      }
      const cell2 = clearSolution(cell, kernel_language, minimal_stubs);
      if (cell !== cell2) {
        // set the input
        this.jupyter_actions.set_cell_input(
          cell.get("id"),
          cell2.get("input"),
          false,
        );
      }
    });
  };

  private assign_clear_hidden_tests = (): void => {
    this.jupyter_actions.store.get("cells").forEach((cell) => {
      // only care about test cells, which have: grade=true and solution=false.
      if (!cell.getIn(["metadata", "nbgrader", "grade"])) return;
      if (cell.getIn(["metadata", "nbgrader", "solution"])) return;
      const cell2 = clear_hidden_tests(cell);
      if (cell !== cell2) {
        // set the input
        this.jupyter_actions.set_cell_input(
          cell.get("id"),
          cell2.get("input"),
          false,
        );
      }
    });
  };

  private assign_clear_mark_regions = (): void => {
    this.jupyter_actions.store.get("cells").forEach((cell) => {
      if (!cell.getIn(["metadata", "nbgrader", "grade"])) {
        // We clear mark regions for any cell that is graded.
        // In the official nbgrader docs, it seems that mark
        // regions are only for **task** cells.  However,
        // I've seen nbgrader use "in nature" that uses
        // the mark regions in other grading cells, and also
        // it just makes sense to be able to easily record
        // how you will grade things even for non-task cells!
        return;
      }
      const cell2 = clear_mark_regions(cell);
      if (cell !== cell2) {
        // set the input
        this.jupyter_actions.set_cell_input(
          cell.get("id"),
          cell2.get("input"),
          false,
        );
      }
    });
  };

  private assign_delete_remove_cells = (): void => {
    const cells: string[] = [];
    this.jupyter_actions.store.get("cells").forEach((cell) => {
      if (!cell.getIn(["metadata", "nbgrader", "remove"])) {
        // we delete cells that have remote true and this one doesn't.
        return;
      }
      // delete the cell
      cells.push(cell.get("id"));
    });
    if (cells.length == 0) return;
    this.jupyter_actions.delete_cells(cells, false);
  };

  private assign_save_checksums = (): void => {
    this.jupyter_actions.store.get("cells").forEach((cell) => {
      if (!cell.getIn(["metadata", "nbgrader", "solution"])) return;
      const cell2 = set_checksum(cell);
      if (cell !== cell2) {
        // set nbgrader metadata, which is all that should have changed
        this.jupyter_actions.set_cell_metadata({
          id: cell.get("id"),
          metadata: { nbgrader: cell2.get("nbgrader") },
          merge: true,
          save: false,
        });
      }
    });
  };

  private assign_unlock_all_cells = (): void => {
    this.jupyter_actions.store.get("cells").forEach((cell) => {
      if (cell == null || !cell.getIn(["metadata", "nbgrader", "locked"]))
        return;
      for (const key of ["editable", "deletable"]) {
        this.jupyter_actions.set_cell_metadata({
          id: cell.get("id"),
          metadata: { [key]: true },
          merge: true,
          save: false,
        });
      }
    });
  };

  private assign_lock_readonly_cells(): void {
    // For every cell for which the nbgrader metadata says it should be locked, set
    // the editable and deletable metadata to false.
    // "metadata":{"nbgrader":{"locked":true,...
    //console.log("assign_lock_readonly_cells");
    this.jupyter_actions.store.get("cells").forEach((cell) => {
      const nbgrader = cell?.getIn(["metadata", "nbgrader"]) as any;
      if (!nbgrader) return;

      // We don't allow student to delete *any* cells with any
      // nbgrader metadata.
      this.jupyter_actions.set_cell_metadata({
        id: cell.get("id"),
        metadata: { deletable: false },
        merge: true,
        save: false,
      });

      if (nbgrader.get("locked")) {
        // In addition, explicitly *locked* cells also can't be edited:
        this.jupyter_actions.set_cell_metadata({
          id: cell.get("id"),
          metadata: { editable: false },
          merge: true,
          save: false,
        });
      }
    });
  }

  ensure_grade_ids_are_unique = (): void => {
    const grade_ids = new Set<string>();
    const cells = this.jupyter_actions.store.get("cells");
    let changed: boolean = false; // did something change.
    cells.forEach((cell, id: string): void => {
      if (cell == null) return;
      const nbgrader = cell.getIn(["metadata", "nbgrader"]) as any;
      if (nbgrader == null) return;
      let grade_id = nbgrader.get("grade_id");
      if (grade_ids.has(grade_id)) {
        let n = 0;
        while (grade_ids.has(grade_id + `${n}`)) {
          n += 1;
        }
        grade_id = grade_id + `${n}`;
        this.set_metadata(id, { grade_id }, false);
        changed = true;
      }
      grade_ids.add(grade_id);
    });
    if (changed) {
      this.jupyter_actions._sync();
    }
  };
}

export function buildStudentVersionIpynb(
  sourceIpynb: any,
  kernelLanguage: string | undefined,
  minimalStubs: boolean = false,
) {
  const importer = new IPynbImporter();
  importer.import({ ipynb: sourceIpynb });
  try {
    const importedCells = importer.cells();
    let cells = immutable.Map<string, immutable.Map<string, any>>();
    let cellList: string[] = [];
    for (const id of Object.keys(importedCells)) {
      cells = cells.set(id, immutable.fromJS(importedCells[id]));
    }
    cellList = Object.values(importedCells)
      .sort((a: any, b: any) => a.pos - b.pos)
      .map((cell: any) => cell.id);

    const updateCell = (
      id: string,
      update: (cell: immutable.Map<string, any>) => immutable.Map<string, any>,
    ) => {
      const cell = cells.get(id);
      if (cell != null) {
        cells = cells.set(id, update(cell));
      }
    };

    for (const id of cellList) {
      updateCell(id, (cell) => {
        if (!cell.getIn(["metadata", "nbgrader", "locked"])) return cell;
        return cell
          .setIn(["metadata", "editable"], true)
          .setIn(["metadata", "deletable"], true);
      });
    }

    for (const id of cellList) {
      updateCell(id, (cell) => {
        if (!cell.getIn(["metadata", "nbgrader", "solution"])) return cell;
        if (cell.getIn(["metadata", "nbgrader", "multiple_choice"]) === true) {
          return cell;
        }
        return clearSolution(cell, kernelLanguage, minimalStubs);
      });
    }

    for (const id of cellList) {
      updateCell(id, (cell) => {
        if (!cell.getIn(["metadata", "nbgrader", "grade"])) return cell;
        if (cell.getIn(["metadata", "nbgrader", "solution"])) return cell;
        return clear_hidden_tests(cell);
      });
    }

    for (const id of cellList) {
      updateCell(id, (cell) => {
        if (!cell.getIn(["metadata", "nbgrader", "grade"])) return cell;
        return clear_mark_regions(cell);
      });
    }

    cellList = cellList.filter((id) => {
      const cell = cells.get(id);
      if (cell?.getIn(["metadata", "nbgrader", "remove"])) {
        cells = cells.delete(id);
        return false;
      }
      return true;
    });

    for (const id of cellList) {
      updateCell(id, (cell) =>
        cell.get("output") != null || cell.get("exec_count")
          ? cell.set("output", null).set("exec_count", null).delete("done")
          : cell,
      );
    }

    for (const id of cellList) {
      updateCell(id, (cell) => {
        if (!cell.getIn(["metadata", "nbgrader", "solution"])) return cell;
        const cellWithChecksum = set_checksum(cell);
        const nbgrader = cellWithChecksum.get("nbgrader");
        return nbgrader == null
          ? cell
          : cell.setIn(["metadata", "nbgrader"], nbgrader);
      });
    }

    for (const id of cellList) {
      updateCell(id, (cell) => {
        const nbgrader = cell.getIn(["metadata", "nbgrader"]) as any;
        if (!nbgrader) return cell;
        cell = cell.setIn(["metadata", "deletable"], false);
        if (nbgrader.get("locked")) {
          cell = cell.setIn(["metadata", "editable"], false);
        }
        return cell;
      });
    }

    return export_to_ipynb({
      cells: cells.toJS(),
      cell_list: cellList,
      metadata: importer.metadata(),
      kernelspec: sourceIpynb?.metadata?.kernelspec,
      language_info: sourceIpynb?.metadata?.language_info,
    });
  } finally {
    importer.close();
  }
}
