// Run against an explicitly enabled preview Metro server; never signs in.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  MAESTRO_CLI_NO_ANALYTICS: "1",
  MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
};
const localMaestro = resolve(
  homedir(),
  ".local/share/cocalc-mobile-tools/maestro/bin/maestro",
);
const maestro =
  env.MAESTRO_BIN || (existsSync(localMaestro) ? localMaestro : "maestro");
if (
  !env.JAVA_HOME &&
  existsSync("/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home")
) {
  env.JAVA_HOME =
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home";
}
function run(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if ((result.error || result.status !== 0) && !allowFailure)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error ?? result.stderr ?? result.status}`,
    );
  return result.stdout?.trim();
}
const sim = (...args) => run("xcrun", ["simctl", ...args], { capture: true });
const port = env.MOBILE_PREVIEW_PORT || "8082";
const status = await fetch(`http://localhost:${port}/status`)
  .then((r) => r.text())
  .catch(() => "");
if (!status.includes("packager-status:running"))
  throw new Error("Start pnpm start:preview in another terminal first.");
run(maestro, ["--version"]);
const devices = Object.values(
  JSON.parse(sim("list", "devices", "available", "--json")).devices,
).flat();
const device =
  env.MOBILE_SIMULATOR_ID ||
  devices.find((d) => d.name === "iPhone 17 Pro")?.udid;
if (!device || !devices.some((d) => d.udid === device))
  throw new Error(
    "Set MOBILE_SIMULATOR_ID to an available iOS simulator UUID.",
  );
if (devices.find((d) => d.udid === device).state !== "Booted")
  sim("boot", device);
run("xcrun", ["simctl", "bootstatus", device, "-b"]);
sim("get_app_container", device, "com.sagemath.cocalc.mobile.dev", "app");
const appearance = sim("ui", device, "appearance");
const textSize = sim("ui", device, "content_size");
const output = resolve(
  root,
  "dist/visual",
  new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(output, { recursive: true });
try {
  for (const [name, theme, size] of [
    ["light", "light", "large"],
    ["dark", "dark", "large"],
    ["large-text", "dark", "accessibility-medium"],
  ]) {
    sim("ui", device, "appearance", theme);
    sim("ui", device, "content_size", size);
    run(
      "xcrun",
      ["simctl", "terminate", device, "com.sagemath.cocalc.mobile.dev"],
      { allowFailure: true, capture: true },
    );
    sim(
      "openurl",
      device,
      `exp+cocalc-mobile://expo-development-client/?url=${encodeURIComponent(`http://localhost:${port}`)}`,
    );
    run(maestro, [
      "--device",
      device,
      "test",
      "--test-output-dir",
      resolve(output, name),
      ".maestro/smoke.yaml",
    ]);
  }
} finally {
  sim("ui", device, "appearance", appearance);
  sim("ui", device, "content_size", textSize);
  console.log(`Visual artifacts: ${output}`);
}
