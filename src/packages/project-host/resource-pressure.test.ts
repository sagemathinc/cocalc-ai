import { _test } from "./resource-pressure";

describe("project resource pressure accounting", () => {
  beforeEach(() => {
    _test.resetSamples();
  });

  it("extracts project ids from project container names", () => {
    const projectId = "11111111-2222-4333-8444-555555555555";

    expect(_test.normalizeContainerName(`/project-${projectId}`)).toBe(
      `project-${projectId}`,
    );
    expect(_test.projectIdFromContainerName(`project-${projectId}`)).toBe(
      projectId,
    );
    expect(_test.projectIdFromContainerName("not-a-project")).toBeUndefined();
  });

  it("counts inotify watches from fdinfo", () => {
    expect(
      _test.countInotifyWatches(`
pos:	0
flags:	02004000
mnt_id:	18
ino:	2083
inotify wd:1 ino:123 sdev:42 mask:fc6 ignored_mask:0 fhandle-bytes:8 fhandle-type:1
inotify wd:2 ino:124 sdev:42 mask:fc6 ignored_mask:0 fhandle-bytes:8 fhandle-type:1
`),
    ).toBe(2);
  });

  it("summarizes cached samples with freshness and largest-offender metrics", () => {
    const now = 1_000_000;
    _test.setSample({
      project_id: "project-a",
      container_id: "container-a",
      container_name: "project-project-a",
      root_pid: 100,
      sampled_at_ms: now - 10_000,
      scan_duration_ms: 3,
      pids: 4,
      threads: 12,
      file_descriptors: 200,
      sockets: 50,
      inotify_instances: 3,
      inotify_watches: 900,
    });
    _test.setSample({
      project_id: "project-b",
      container_id: "container-b",
      container_name: "project-project-b",
      root_pid: 200,
      sampled_at_ms: now - 10 * 60_000,
      scan_duration_ms: 6,
      pids: 8,
      threads: 20,
      file_descriptors: 150,
      sockets: 80,
      inotify_instances: 5,
      inotify_watches: 100,
      truncated: true,
    });

    const summary = _test.summarizeResourcePressure({
      running_project_ids: ["project-a", "project-b", "project-c"],
      now,
      last_scan: {
        duration_ms: 42,
        project_count: 2,
        truncated: true,
        error_count: 1,
      },
    });

    expect(summary.running_project_count).toBe(3);
    expect(summary.sampled_project_count).toBe(2);
    expect(summary.fresh_project_count).toBe(1);
    expect(summary.stale_project_count).toBe(1);
    expect(summary.missing_project_count).toBe(1);
    expect(summary.truncated_project_count).toBe(1);
    expect(summary.total_pids).toBe(12);
    expect(summary.total_threads).toBe(32);
    expect(summary.total_file_descriptors).toBe(350);
    expect(summary.total_sockets).toBe(130);
    expect(summary.total_inotify_instances).toBe(8);
    expect(summary.total_inotify_watches).toBe(1000);
    expect(summary.last_scan_duration_ms).toBe(42);
    expect(summary.largest_file_descriptors?.project_id).toBe("project-a");
    expect(summary.largest_sockets?.project_id).toBe("project-b");
    expect(summary.largest_inotify_instances?.project_id).toBe("project-b");
    expect(summary.largest_inotify_watches?.project_id).toBe("project-a");
  });
});
