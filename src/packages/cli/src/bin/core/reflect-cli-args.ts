// @cocalc/cli still pins the independently published 0.15.x npm package.
// Keep this boundary adapter until that dependency advances to 0.17.x;
// the new Reflect CLI itself has no legacy command aliases.
export function reflectCliArgs(args: string[], version: string): string[] {
  if (args[0] !== "forward" || args[1] !== "remove") return args;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match)
    throw Error("Unable to establish the installed Reflect CLI version");
  if (Number(match[1]) > 0 || Number(match[2]) >= 17) return args;
  if (!args.includes("--stop"))
    throw Error("This Reflect version requires --stop for forward removal");
  return [
    "forward",
    "terminate",
    ...args.slice(2).filter((arg) => arg !== "--stop"),
  ];
}
