import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as bootstrapHost from "./bootstrap-host";

const { resolveBootstrapImageSizeGb, resolveBootstrapRootReserveGb } =
  bootstrapHost;

describe("resolveBootstrapImageSizeGb", () => {
  it("uses auto sizing for Lambda hosts", () => {
    expect(
      resolveBootstrapImageSizeGb({
        providerId: "lambda",
        isSelfHost: false,
        diskGb: 100,
      }),
    ).toBe("auto");
  });

  it("uses auto sizing for self-host", () => {
    expect(
      resolveBootstrapImageSizeGb({
        providerId: "self-host",
        isSelfHost: true,
        diskGb: 100,
      }),
    ).toBe("auto");
  });

  it("keeps explicit disk sizing for other cloud providers", () => {
    expect(
      resolveBootstrapImageSizeGb({
        providerId: "gcp",
        isSelfHost: false,
        diskGb: 250,
      }),
    ).toBe("250");
  });

  it("enforces the minimum image size for non-auto providers", () => {
    expect(
      resolveBootstrapImageSizeGb({
        providerId: "gcp",
        isSelfHost: false,
        diskGb: 10,
      }),
    ).toBe("20");
  });
});

describe("resolveBootstrapRootReserveGb", () => {
  it("defaults to a 25 GiB root reserve", () => {
    expect(resolveBootstrapRootReserveGb()).toBe("25");
  });

  it("accepts explicit positive overrides", () => {
    expect(resolveBootstrapRootReserveGb(24)).toBe("24");
    expect(resolveBootstrapRootReserveGb("32")).toBe("32");
  });
});

describe("resolveSoftwareBaseUrl", () => {
  it("rewrites loopback forced software bases through the public launchpad origin for cloud hosts", async () => {
    await expect(
      bootstrapHost.resolveSoftwareBaseUrl({
        configured: "http://localhost:13214/software",
        useOnPremSettings: false,
        host_id: "host-123",
        launchpadBaseUrl: "https://bay-2-lite4b.cocalc.ai",
      }),
    ).resolves.toBe("https://bay-2-lite4b.cocalc.ai/software");
  });

  it("preserves loopback software bases for local self-host bootstrap", async () => {
    await expect(
      bootstrapHost.resolveSoftwareBaseUrl({
        configured: "http://localhost:13214/software",
        useOnPremSettings: true,
        host_id: "host-123",
        launchpadBaseUrl: "https://bay-2-lite4b.cocalc.ai",
      }),
    ).resolves.toBe("http://localhost:13214/software");
  });

  it("preserves explicitly public software bases", async () => {
    await expect(
      bootstrapHost.resolveSoftwareBaseUrl({
        configured: "https://software.example.test/software",
        useOnPremSettings: false,
        host_id: "host-123",
        launchpadBaseUrl: "https://bay-2-lite4b.cocalc.ai",
      }),
    ).resolves.toBe("https://software.example.test/software");
  });
});

describe("GCP bootstrap helpers", () => {
  it("normalizes GCP project ids", () => {
    expect(bootstrapHost.normalizeGcpProjectId(" Proj-ABC ")).toBe("proj-abc");
    expect(bootstrapHost.normalizeGcpProjectId("")).toBeUndefined();
  });

  it("extracts configured GCP project id from the service account json", () => {
    expect(
      bootstrapHost.configuredGcpProjectIdFromServiceAccountJson(
        JSON.stringify({ project_id: "Proj-ABC" }),
      ),
    ).toBe("proj-abc");
  });

  it("ignores invalid configured GCP service account json", () => {
    expect(
      bootstrapHost.configuredGcpProjectIdFromServiceAccountJson("{"),
    ).toBeUndefined();
  });

  it("describes every project-writable balanced disk for I/O containment", () => {
    expect(
      bootstrapHost.buildProjectIoCapacity({
        providerId: "gcp",
        diskType: "balanced",
        sharedScratchEnabled: true,
        sharedScratchDiskType: "balanced",
      }),
    ).toEqual({
      version: 1,
      provider: "gcp",
      targets: [
        {
          mountpoint: "/mnt/cocalc",
          discovery: "btrfs",
          disk_type: "balanced",
          required: true,
        },
        {
          mountpoint: "/mnt/cocalc-scratch",
          discovery: "mount",
          disk_type: "balanced",
          required: true,
        },
      ],
    });
  });

  it("enforces provider-derived I/O containment on GCP balanced disks", () => {
    expect(
      bootstrapHost.buildProjectIoPolicy({
        providerId: "gcp",
        diskType: "balanced",
        sharedScratchEnabled: true,
        sharedScratchDiskType: "balanced",
      }),
    ).toMatchObject({
      mode: "enforce",
      profile: "gcp-pd-balanced-btrfs-headroom",
      capacity: { mode: "gcp-pd-balanced" },
      pool: { rbps: 67108864, wbps: 33554432, riops: 2000, wiops: 1000 },
    });
  });

  it("fails safe when project-writable storage is not uniformly supported", () => {
    expect(
      bootstrapHost.buildProjectIoPolicy({
        providerId: "gcp",
        diskType: "balanced",
        sharedScratchEnabled: true,
        sharedScratchDiskType: "ssd",
      }),
    ).toMatchObject({
      mode: "disabled",
      profile: "unconfigured",
      capacity: { mode: "static" },
    });
    expect(
      bootstrapHost.buildProjectIoPolicy({
        providerId: "lambda",
        diskType: "balanced",
        sharedScratchEnabled: false,
      }),
    ).toMatchObject({ mode: "disabled" });
  });
});

describe("bootstrap-host shell templates", () => {
  it("defaults new project hosts to Node 26", () => {
    expect(bootstrapHost.DEFAULT_PROJECT_HOST_NODE_VERSION).toBe("26");
  });

  it("keeps carriage-return stripping as a literal backslash-r sequence", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(`tr -d '\\\\r'`);
    expect(source).not.toContain("tr -d '\r'");
  });

  it("writes the bootstrap payload to a fresh name in the root-only state dir", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(
      `BOOTSTRAP_PAYLOAD="$(umask 077 && mktemp "$BOOTSTRAP_DIR/bootstrap.payload.XXXXXX")"`,
    );
    expect(source).toContain(`trap 'rm -f "$BOOTSTRAP_PAYLOAD"' EXIT`);
    expect(source).toContain(`-o "$BOOTSTRAP_PAYLOAD"`);
    expect(source).toContain(`bash "$BOOTSTRAP_PAYLOAD"`);
    expect(source).not.toContain(`bootstrap.payload.sh`);
    expect(source).not.toContain(`-o "$BOOTSTRAP_DIR/bootstrap.sh"`);
  });

  it("installs libatomic for the Node 26 runtime", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(`"libatomic1"`);
  });

  it("installs rootless podman debugging helpers for the runtime user", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(
      `cat <<'EOF_COCALC_AS_RUNTIME' > "$BOOTSTRAP_ROOT/bin/as-runtime"`,
    );
    expect(source).toContain(`exec sudo -Hiu "$RUNTIME_USER" bash -lc`);
    expect(source).toContain(`> "$BOOTSTRAP_ROOT/bin/podman"`);
    expect(source).toContain(`> "$BOOTSTRAP_ROOT/bin/project-exec"`);
    expect(source).toContain(
      `$HOME/cocalc-host/bin/project-exec <project-id> pwd`,
    );
  });

  it("supports inlining the rendered bootstrap payload for ssh reconcile", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(`inlineBootstrapPayload?: boolean;`);
    expect(source).toContain(`await buildBootstrapScriptWithStatus(`);
    expect(source).toContain(
      `cat <<'EOF_COCALC_INLINE_BOOTSTRAP_PAYLOAD' > "$BOOTSTRAP_PAYLOAD"`,
    );
  });

  it("keeps bootstrap state in a root-only directory, never on the data disk", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(bootstrapHost.BOOTSTRAP_STATE_ROOT).toBe(
      "/var/lib/cocalc-host-bootstrap",
    );
    expect(source).toContain(`BOOTSTRAP_DIR="$BOOTSTRAP_STATE_ROOT/bootstrap"`);
    expect(source).toContain(`BOOTSTRAP_LOG="$BOOTSTRAP_DIR/bootstrap.log"`);
    expect(source).toContain(`install -d -o root -g root -m 0700 "$dir"`);
    expect(source).toContain(`"0:0 700 directory"`);
    expect(source).not.toContain(`/mnt/cocalc/data/.host-bootstrap`);
  });

  it("never hands bootstrap state, bootstrap.py or the payload to another user", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).not.toContain(`"$BOOTSTRAP_STATE_ROOT" || true`);
    expect(source).not.toMatch(/chown [^\n]*"\$BOOTSTRAP_PAYLOAD"/);
    expect(source).not.toMatch(/chown [^\n]*"\$target"/);
    expect(source).not.toMatch(/chown [^\n]*bootstrap\.py/);
  });

  it("decides first boot versus reconcile from root-owned markers only", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(
      `if [ -f "$BOOTSTRAP_STATE_ROOT/.bootstrap_done" ] && [ ! -L "$BOOTSTRAP_STATE_ROOT/.bootstrap_done" ]; then`,
    );
    // /var/lib/cocalc counts only while it is root's alone (runtime-owned on older hosts)
    expect(source).toContain(
      `elif legacy_bootstrap_done_marker_is_roots; then`,
    );
    expect(source).toContain(
      `ignoring a bootstrap marker that is not root's alone`,
    );
    expect(source).not.toMatch(/-f \/mnt\/cocalc\/data\/\.bootstrap_done/);
    expect(source).toContain(
      `"bootstrap_done_paths": ["\${BOOTSTRAP_STATE_ROOT}/.bootstrap_done"],`,
    );
  });

  it("keeps the bootstrap CA certificate out of /tmp", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).not.toContain(`/tmp/cocalc-bootstrap-ca.pem`);
    expect(source).toContain(
      `BOOTSTRAP_CACERT_PATH="$BOOTSTRAP_STATE_ROOT/bootstrap-ca.pem"`,
    );
  });

  it("never traces the scripts or writes the master conat token by path", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/set -[a-z]*x/);
    expect(source).not.toContain(`set -o xtrace`);
    expect(source).not.toContain(`bash -x`);
    expect(source).not.toContain(`conatPasswordCommand`);
    expect(source).not.toContain(`sudo tee /mnt/cocalc/data/secrets`);
  });

  it("runs explicit reconcile mode after bootstrap is already complete", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(
      `python3 -I "$BOOTSTRAP_DIR/bootstrap.py" reconcile --bootstrap-dir "$BOOTSTRAP_DIR"`,
    );
    expect(source).toContain(
      `python3 -I "$BOOTSTRAP_DIR/bootstrap.py" helpers --bootstrap-dir "$BOOTSTRAP_DIR"`,
    );
    expect(source).toContain(
      `python3 -I "$BOOTSTRAP_DIR/bootstrap.py" environment --bootstrap-dir "$BOOTSTRAP_DIR"`,
    );
    // every root python run is isolated from its script dir and environment
    expect(source).not.toMatch(/python3 (?!-I )"\$BOOTSTRAP_DIR/);
    expect(source).toContain(`COCALC_BOOTSTRAP_RECONCILE_SCOPE`);
    // Only the provider's boot-time run (no control-plane scope) keeps a
    // running stack whose software did not change.
    expect(source).toContain(
      `BOOTSTRAP_RECONCILE_RESTART_ARG="--restart-if-changed"`,
    );
    expect(source).toContain(
      `reconcile --bootstrap-dir "$BOOTSTRAP_DIR" $BOOTSTRAP_RECONCILE_RESTART_ARG`,
    );
    expect(source).not.toContain(
      `python3 "$BOOTSTRAP_DIR/bootstrap.py" --config "$BOOTSTRAP_DIR/bootstrap-config.json" --only cloudflared`,
    );
  });

  it("writes split bootstrap host facts and desired state instead of bootstrap-config.json", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(`> "$BOOTSTRAP_DIR/bootstrap-host-facts.json"`);
    expect(source).toContain(`> "$BOOTSTRAP_DIR/bootstrap-desired-state.json"`);
    expect(source).not.toContain(`> "$BOOTSTRAP_DIR/bootstrap-config.json"`);
  });

  it("passes shared scratch configuration through split bootstrap state", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(`"shared_scratch_disk_devices"`);
    expect(source).toContain(`"shared_scratch"`);
    expect(source).toContain(`"project_io_capacity"`);
    expect(source).toContain(`"project_io_policy"`);
    expect(source).toContain(`/mnt/cocalc-scratch`);
    expect(source).toContain(`COCALC_SHARED_SCRATCH_HOST_MOUNT`);
  });

  it("does not make bootstrap execution depend on tee writing the log file", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(`if ! bash "$BOOTSTRAP_PAYLOAD"; then`);
    expect(source).not.toContain(
      `if ! bash "$BOOTSTRAP_PAYLOAD" 2>&1 | tee "$BOOTSTRAP_DIR/bootstrap.log"; then`,
    );
    expect(source).toContain(`bootstrap_log_tail() {`);
  });
});

describe("bootstrap reconcile over ssh", () => {
  const SENTINEL = "SENTINEL-reconcile-token-4b2e8a";

  function prepare(dataLogsIsFile = false, extra = "") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-reconcile-"));
    const state = path.join(dir, "state");
    const dataLogs = path.join(dir, "data-logs");
    if (dataLogsIsFile) fs.writeFileSync(dataLogs, "not a dir");
    const shims = path.join(dir, "shims");
    fs.mkdirSync(shims);
    const launcher = `#!/bin/bash
TOKEN="${SENTINEL}"
${extra}
echo "launcher ran scope=$COCALC_BOOTSTRAP_RECONCILE_SCOPE"
touch "${dir}/launcher-ran"
`;
    const script = bootstrapHost
      .buildBootstrapReconcileSshScript({
        launcher,
        scope: "helpers",
        runtimeUser: "cocalc-host",
      })
      .split("/var/lib/cocalc-host-bootstrap")
      .join(state)
      .split("/mnt/cocalc/data/logs")
      .join(dataLogs);
    const shim = (name: string, body: string) =>
      fs.writeFileSync(path.join(shims, name), `#!/bin/bash\n${body}\n`, {
        mode: 0o755,
      });
    shim("sudo", `[ "$1" = "-n" ] && shift\nexec "$@"`);
    shim(
      "runuser",
      `while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\n[ -n "$STALL_COPY" ] && exec sh -c 'trap "" HUP; while :; do kill -STOP $$; done' "$SHIM_ROOT-copy"\nexec "$@"`,
    );
    shim(
      "install",
      `args=()
while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done
exec /usr/bin/install "\${args[@]}"`,
    );
    shim(
      "stat",
      `out="$(/usr/bin/stat "$@")" || exit $?
case "$*" in
  *"$SHIM_ROOT"*) printf '%s\\n' "$out" | sed -E 's/^[0-9]+:[0-9]+ /0:0 /' ;;
  *" /var/lib") printf '%s\\n' "$out" | sed -E 's/^[0-9]+:/0:/' ;;
  *) printf '%s\\n' "$out" ;;
esac`,
    );
    return { dir, state, dataLogs, shims, script };
  }

  function runOverSsh(ctx: ReturnType<typeof prepare>, stallCopy = "") {
    // like runSshScript: the script on stdin of bash -se
    return spawnSync("bash", ["-se"], {
      input: ctx.script,
      encoding: "utf8",
      env: {
        PATH: `${ctx.shims}:/usr/bin:/bin`,
        HOME: ctx.dir,
        SHIM_ROOT: ctx.state,
        STALL_COPY: stallCopy,
      },
    });
  }

  // processes (of this test) whose command line names its directory
  function leftovers(ctx: ReturnType<typeof prepare>): string[] {
    return spawnSync("ps", ["-eo", "pid=,stat=,args="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((line) => line.includes(ctx.dir) && !line.includes(" ps "));
  }

  function waitFor(check: () => boolean, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      spawnSync("sleep", ["0.1"]);
    }
  }

  it("runs the launcher as root from the root-only state dir without printing the token", () => {
    const ctx = prepare();
    const result = runOverSsh(ctx);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SENTINEL);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("started bootstrap reconcile pid=");
    waitFor(() => fs.existsSync(path.join(ctx.dir, "launcher-ran")));
    const rootLog = path.join(
      ctx.state,
      "bootstrap",
      "bootstrap-reconcile.log",
    );
    const copy = path.join(ctx.dataLogs, "bootstrap-reconcile.log");
    waitFor(
      () =>
        fs.existsSync(copy) &&
        fs.readFileSync(copy, "utf8").includes("launcher ran") &&
        fs
          .readdirSync(path.join(ctx.state, "bootstrap"))
          .every((name) => !name.startsWith("reconcile-launcher")),
    );
    expect(fs.readFileSync(rootLog, "utf8")).toContain(
      "launcher ran scope=helpers",
    );
    expect(fs.readFileSync(copy, "utf8")).toContain(
      "launcher ran scope=helpers",
    );
  });

  it("keeps reconciling when the runtime user's log copy cannot be written", () => {
    const ctx = prepare(true);
    const result = runOverSsh(ctx);
    expect(result.status).toBe(0);
    waitFor(() => fs.existsSync(path.join(ctx.dir, "launcher-ran")));
    const rootLog = path.join(
      ctx.state,
      "bootstrap",
      "bootstrap-reconcile.log",
    );
    waitFor(
      () =>
        fs.existsSync(rootLog) &&
        fs.readFileSync(rootLog, "utf8").includes("launcher ran"),
    );
  });

  it("leaves no follower behind once the reconcile is done", () => {
    const ctx = prepare();
    expect(runOverSsh(ctx).status).toBe(0);
    waitFor(() =>
      fs
        .readdirSync(path.join(ctx.state, "bootstrap"))
        .every((name) => !name.startsWith("reconcile-launcher")),
    );
    // tail --pid ends within about a second of the reconcile
    waitFor(() => leftovers(ctx).length === 0, 5_000);
    expect(
      fs
        .readdirSync(path.join(ctx.state, "bootstrap"))
        .filter((name) => name.startsWith("reconcile-run")),
    ).toEqual([]);
  });

  it("finishes the reconcile, then ends the follower, when the runtime user's copy is stopped", () => {
    // more than a pipe buffer of output, while the copy never reads: it
    // stops itself again whenever continued, and ignores SIGHUP (so the
    // kernel's orphaned-group HUP+CONT doesn't end it)
    const ctx = prepare(false, 'head -c 300000 /dev/zero | tr "\\0" x; echo');
    const result = runOverSsh(ctx, "1");
    expect(result.status).toBe(0);
    waitFor(() => fs.existsSync(path.join(ctx.dir, "launcher-ran")));
    waitFor(() =>
      fs
        .readdirSync(path.join(ctx.state, "bootstrap"))
        .every((name) => !name.startsWith("reconcile-launcher")),
    );
    const rootLog = path.join(
      ctx.state,
      "bootstrap",
      "bootstrap-reconcile.log",
    );
    expect(fs.statSync(rootLog).size).toBeGreaterThan(300000);
    expect(fs.readFileSync(rootLog, "utf8")).toContain(
      "launcher ran scope=helpers",
    );
    // the copy really is stopped, and holds root's follower
    expect(leftovers(ctx).some((line) => / T/.test(line))).toBe(true);
    // a few seconds later: TERM (+CONT) from timeout, nothing left
    waitFor(() => leftovers(ctx).length === 0, 20_000);
  }, 30_000);

  it("copies each run's output once, even with reconciles running at once", () => {
    const ctx = prepare(false, 'echo "run-$$"; sleep 1');
    fs.mkdirSync(path.join(ctx.state, "bootstrap"), { recursive: true });
    fs.writeFileSync(
      path.join(ctx.state, "bootstrap", "bootstrap-reconcile.log"),
      "an earlier run\n",
    );
    expect(runOverSsh(ctx).status).toBe(0);
    expect(runOverSsh(ctx).status).toBe(0);
    const copy = path.join(ctx.dataLogs, "bootstrap-reconcile.log");
    waitFor(
      () =>
        fs.existsSync(copy) &&
        (fs.readFileSync(copy, "utf8").match(/launcher ran/g) ?? []).length ===
          2,
    );
    waitFor(() => leftovers(ctx).length === 0, 5_000);
    const text = fs.readFileSync(copy, "utf8");
    expect(text).not.toContain("an earlier run");
    const runs = text.match(/run-\d+/g) ?? [];
    expect(runs).toHaveLength(2);
    expect(new Set(runs).size).toBe(2);
    expect(text.match(/launcher ran/g)).toHaveLength(2);
  });

  it("has the ssh user write nothing: everything happens in one sudo'd root script", () => {
    const script = bootstrapHost.buildBootstrapReconcileSshScript({
      launcher: "echo hi",
      scope: "full",
      runtimeUser: "cocalc-host",
    });
    const lines = script.split("\n");
    expect(lines[0]).toBe("set -euo pipefail");
    expect(lines[1]).toBe(
      "sudo -n env COCALC_BOOTSTRAP_RECONCILE_SCOPE=full bash -s <<'EOF_COCALC_RECONCILE_ROOT'",
    );
    expect(
      lines.filter((line) => line === "EOF_COCALC_RECONCILE_ROOT"),
    ).toHaveLength(1);
    expect(script.trimEnd().endsWith("EOF_COCALC_RECONCILE_ROOT")).toBe(true);
    // the reconcile writes root's log only; the copy is fed by a bounded
    // follower, so a stalled copy can't block it
    expect(script).toContain('(bash "$1" 2>&1 | tee -a "$2" > "$4") &');
    expect(script).not.toContain("tee -p");
    expect(script).toContain(
      'timeout --kill-after=30s 1h tail -c +1 -f --pid="$pid" "$4"',
    );
    expect(script).toContain(
      'exec 3> >(exec timeout --kill-after=30s 1h runuser -u "$3" --',
    );
    expect(script).not.toContain("/mnt/cocalc/data/.host-bootstrap");
    // the data dir is only ever written by the runtime user (its log copy)
    for (const line of lines.filter((line) =>
      line.includes("/mnt/cocalc/data/logs"),
    )) {
      expect(line).toContain('runuser -u "$3" --');
    }
  });

  it("rejects an unknown scope or runtime user", () => {
    expect(() =>
      bootstrapHost.buildBootstrapReconcileSshScript({
        launcher: "",
        scope: "bogus" as any,
      }),
    ).toThrow(/scope/);
    expect(() =>
      bootstrapHost.buildBootstrapReconcileSshScript({
        launcher: "",
        scope: "full",
        runtimeUser: "x; rm -rf /",
      }),
    ).toThrow(/runtime user/);
  });
});
