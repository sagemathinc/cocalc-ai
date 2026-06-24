import { buildStudentVersionIpynb, NBGraderActions } from "./actions";

describe("NBGraderActions", () => {
  it("writes the transformed student notebook before opening it", async () => {
    const calls: string[] = [];
    const fs = {
      writeFile: jest.fn(async () => {
        calls.push("writeFile");
      }),
    };
    const redux = {
      getProjectActions: jest.fn(() => ({
        ensureContainingDirectoryExists: jest.fn(async () => {
          calls.push("ensureContainingDirectoryExists");
        }),
        fs: jest.fn(() => fs),
        open_file: jest.fn(async () => {
          calls.push("open_file");
        }),
      })),
      getEditorActions: jest.fn(),
    };
    const sourceJupyterActions = {
      project_id: "project-1",
      store: {
        get_kernel_language: jest.fn(() => "python"),
      },
      toIpynb: jest.fn(async () => {
        calls.push("toIpynb");
        return {
          cells: [
            {
              id: "cell-1",
              cell_type: "code",
              metadata: {
                nbgrader: {
                  grade: false,
                  locked: false,
                  solution: true,
                  schema_version: 3,
                },
              },
              outputs: [{ output_type: "stream", name: "stdout", text: "x" }],
              source: [
                "### BEGIN SOLUTION\n",
                "answer = 10\n",
                "### END SOLUTION\n",
              ],
            },
          ],
          metadata: { kernelspec: { name: "python3", language: "python" } },
          nbformat: 4,
          nbformat_minor: 5,
        };
      }),
    };

    const actions = new NBGraderActions(sourceJupyterActions, redux);
    await actions.assign("student/a.ipynb");

    expect(redux.getEditorActions).not.toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledWith(
      "student/a.ipynb",
      expect.stringContaining("# YOUR CODE HERE"),
      true,
    );
    expect(fs.writeFile.mock.calls[0][1]).not.toContain("answer = 10");
    expect(calls).toEqual([
      "toIpynb",
      "ensureContainingDirectoryExists",
      "writeFile",
      "open_file",
    ]);
  });

  it("builds a transformed student ipynb without clearing it to blank", () => {
    const student = buildStudentVersionIpynb(
      {
        cells: [
          {
            id: "solution",
            cell_type: "code",
            metadata: {
              nbgrader: {
                grade: false,
                locked: false,
                solution: true,
                schema_version: 3,
              },
            },
            outputs: [{ output_type: "stream", name: "stdout", text: "x" }],
            source: [
              "### BEGIN SOLUTION\n",
              "answer = 10\n",
              "### END SOLUTION\n",
            ],
          },
          {
            id: "locked",
            cell_type: "markdown",
            metadata: {
              nbgrader: {
                grade: false,
                locked: true,
                solution: false,
                schema_version: 3,
              },
            },
            source: ["Read this."],
          },
          {
            id: "removed",
            cell_type: "code",
            metadata: {
              nbgrader: {
                grade: false,
                locked: false,
                remove: true,
                solution: false,
                schema_version: 3,
              },
            },
            source: ["secret = 1"],
          },
        ],
        metadata: { kernelspec: { name: "python3", language: "python" } },
        nbformat: 4,
        nbformat_minor: 5,
      },
      "python",
    );

    expect(student.cells).toHaveLength(2);
    expect(student.cells[0].source.join("")).toContain("# YOUR CODE HERE");
    expect(student.cells[0].source.join("")).not.toContain("answer = 10");
    expect(student.cells[0].outputs).toEqual([]);
    expect(student.cells[1].metadata.editable).toBe(false);
    expect(student.cells[1].metadata.deletable).toBe(false);
    expect(student.cells.map((cell) => cell.id)).not.toContain("removed");
  });
});
