/* This runs only in the isolated controller, never in a project shell. */
export function claudeUsageScript(sdkPath: string): string {
  return `
const { query } = await import(${JSON.stringify(sdkPath)});
let finish;
const done = new Promise(resolve => { finish = resolve; });
async function* prompts() { await done; }
const session = query({ prompt: prompts(), options: {
  cwd: "/workspace", settingSources: [], plugins: [], tools: [],
  mcpServers: {}, persistSession: false,
  canUseTool: async () => ({ behavior: "deny", message: "Usage only" })
}});
try {
  await session.initializationResult();
  const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  process.stdout.write(JSON.stringify(usage));
} catch {
  process.exitCode = 1;
} finally {
  finish();
  session.close();
}
`;
}
