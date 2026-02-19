import { execFileSync } from "node:child_process";

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function shouldRequireKernel(): boolean {
  return envFlag("COCALC_JUPYTER_E2E_REQUIRE_KERNEL") || envFlag("CI");
}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number = 30_000,
): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      encoding: "utf8",
    });
    return { stdout: stdout ?? "", stderr: "" };
  } catch (err: any) {
    const stderr =
      typeof err?.stderr === "string"
        ? err.stderr
        : err?.stderr?.toString?.() ?? "";
    const stdout =
      typeof err?.stdout === "string"
        ? err.stdout
        : err?.stdout?.toString?.() ?? "";
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    const rendered = detail ? `\n${detail}` : "";
    throw new Error(
      `command failed: ${cmd} ${args.join(" ")}${rendered}`.trim(),
    );
  }
}

function detectPython(): string {
  const preferred = process.env.COCALC_JUPYTER_E2E_PYTHON?.trim();
  const candidates = [
    preferred,
    "python3",
    "python",
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    try {
      run(candidate, [
        "-c",
        "import sys; print(sys.executable)",
      ]);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    "unable to find a usable Python interpreter (tried COCALC_JUPYTER_E2E_PYTHON, python3, python)",
  );
}

function verifyKernelProvisioning(python: string): void {
  run(python, [
    "-c",
    "import ipykernel, jupyter_client; print(ipykernel.__version__)",
  ]);

  // Launch an actual kernel and wait for ready to ensure runtime execution
  // preconditions are present in strict environments (e.g. CI).
  run(
    python,
    [
      "-c",
      [
        "from jupyter_client import KernelManager",
        "km = KernelManager(kernel_name='python3')",
        "km.start_kernel()",
        "kc = km.client()",
        "kc.start_channels()",
        "kc.wait_for_ready(timeout=20)",
        "kc.stop_channels()",
        "km.shutdown_kernel(now=True)",
        "print('ok')",
      ].join("; "),
    ],
    45_000,
  );
}

async function globalSetup(): Promise<void> {
  if (!shouldRequireKernel()) return;

  const python = detectPython();
  verifyKernelProvisioning(python);
}

export default globalSetup;
