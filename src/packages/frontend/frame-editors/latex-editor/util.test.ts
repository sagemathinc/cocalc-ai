import { EventEmitter } from "events";

import { runJob } from "./util";

let stream: EventEmitter;

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_client: {
      execStream: jest.fn(() => stream),
    },
  },
}));

describe("LaTeX runJob", () => {
  beforeEach(() => {
    stream = new EventEmitter();
  });

  it("keeps streamed latex output when a generic stream error arrives", async () => {
    const setJobInfo = jest.fn();
    const promise = runJob({
      aggregate: 1,
      command: "latexmk",
      args: ["-pdf", "paper.tex"],
      project_id: "project-1",
      runDir: "/home/user",
      set_job_info: setJobInfo,
      path: "/home/user/paper.tex",
    });

    const job = {
      type: "async" as const,
      job_id: "job-1",
      start: 1,
      status: "running" as const,
      stdout: "",
      stderr: "",
      exit_code: 0,
    };
    stream.emit("job", job);
    stream.emit("stdout", "Latexmk: applying rule 'pdflatex'...\n");
    stream.emit("error", new Error("An error occurred."));

    await expect(promise).resolves.toMatchObject({
      type: "async",
      job_id: "job-1",
      stdout: "Latexmk: applying rule 'pdflatex'...\n",
    });
    expect(setJobInfo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        job_id: "job-1",
        stdout: "Latexmk: applying rule 'pdflatex'...\n",
      }),
    );
  });

  it("rejects concrete stream errors with useful build context", async () => {
    const promise = runJob({
      aggregate: 1,
      command: "latexmk",
      args: ["-pdf", "paper.tex"],
      project_id: "project-1",
      runDir: "/home/user",
      set_job_info: jest.fn(),
      path: "/home/user/paper.tex",
    });

    stream.emit("error", new Error("Project must be running"));

    await expect(promise).rejects.toThrow(
      "Unable to run LaTeX build for /home/user/paper.tex using latexmk -pdf paper.tex.\n\nProject must be running",
    );
  });
});
