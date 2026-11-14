// Part of plus/bun/smoke.sh: a reflect-sync session through Lite's hub API, as
// the frontend creates one (the reflect manager in-process, its scheduler as
// `cocalc-plus --run-reflect-scheduler`), and the file it must sync.
//
// node smoke-reflect.cjs <conat dist> <address> <account_id> <alpha> <beta>

const fs = require("node:fs");
const path = require("node:path");

const [conat, address, account_id, alpha, beta] = process.argv.slice(2);
const { connect } = require(path.join(conat, "core", "client"));
const { inboxPrefix } = require(path.join(conat, "names"));

async function main() {
  const client = connect({
    address,
    noCache: true,
    inboxPrefix: inboxPrefix({ account_id }),
  });
  const subject = `hub.account.${account_id}.api`;
  const call = async (name, ...args) => {
    const resp = await client.request(
      subject,
      { name, args },
      { timeout: 30000 },
    );
    if (resp.headers?.error) throw new Error(`${name}: ${resp.headers.error}`);
    return resp.data;
  };
  fs.writeFileSync(path.join(alpha, "a.txt"), "hello reflect\n");
  await call("reflect.createSessionUI", { alpha, beta, name: "smoke" });
  const target = path.join(beta, "a.txt");
  const until = Date.now() + 60000;
  while (!fs.existsSync(target) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const synced = fs.existsSync(target) && fs.readFileSync(target, "utf8");
  await call("reflect.terminateSessionUI", { idOrName: "smoke" });
  if (synced !== "hello reflect\n") {
    throw new Error(`the session did not sync ${target}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`smoke-reflect: ${err?.message ?? err}`);
    process.exit(1);
  },
);
