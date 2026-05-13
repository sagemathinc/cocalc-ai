#!/usr/bin/env node
/*
 * Minimal local SAML IdP launcher for CoCalc SSO development.
 *
 * This intentionally depends on `pnpm dlx saml-idp@1.2.1` instead of adding a
 * production dependency. It creates a disposable local IdP signing certificate,
 * prints the matching CoCalc provider config, then starts the test IdP.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(__dirname, "../..");

function usage() {
  console.log(`Usage: pnpm dev:saml:idp [options]

Options:
  --cocalc-url <url>   CoCalc origin. Defaults to COCALC_SITE_URL,
                       or http://localhost:5000.
  --provider <id>      SAML provider id configured in CoCalc. Default: dev-saml.
  --port <port>        Local test IdP port. Default: 7000.
  --host <host>        Local test IdP host. Default: localhost.
  --workdir <path>     Directory for dev cert/config. Default: src/.saml-dev.
  --print-only         Print config without starting saml-idp.
`);
}

function takeArg(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const provider = takeArg(args, "--provider", "dev-saml");
const port = Number(takeArg(args, "--port", "7000"));
const host = takeArg(args, "--host", "localhost");
const workdir = resolve(takeArg(args, "--workdir", join(srcRoot, ".saml-dev")));
const cocalcUrl = takeArg(
  args,
  "--cocalc-url",
  process.env.COCALC_SITE_URL ?? "http://localhost:5000",
).replace(/\/+$/, "");
const printOnly = args.includes("--print-only");

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`invalid --port '${port}'`);
}

mkdirSync(workdir, { recursive: true });
const certPath = join(workdir, "idp-public-cert.pem");
const keyPath = join(workdir, "idp-private-key.pem");
const configPath = join(workdir, "saml-idp-config.js");

if (!existsSync(certPath) || !existsSync(keyPath)) {
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/C=US/ST=California/L=San Francisco/O=CoCalc/CN=CoCalc Dev SAML IdP",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3650",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error("openssl failed to generate the dev SAML keypair");
  }
}

writeFileSync(
  configPath,
  `module.exports = {
  user: {
    userName: "dev-saml-user",
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    firstName: "Dev",
    lastName: "SAML",
    email: "dev-saml@example.com",
  },
  metadata: [
    {
      id: "email",
      optional: false,
      displayName: "Email",
      description: "User email address",
      multiValue: false,
    },
    {
      id: "firstName",
      optional: false,
      displayName: "First name",
      description: "User first name",
      multiValue: false,
    },
    {
      id: "lastName",
      optional: false,
      displayName: "Last name",
      description: "User last name",
      multiValue: false,
    },
  ],
};
`,
);

const idpUrl = `http://${host}:${port}`;
const issuer = "urn:cocalc:dev:saml-idp";
const spEntityId = `${cocalcUrl}/auth/${provider}/metadata`;
const acsUrl = `${cocalcUrl}/auth/${provider}/return`;
const cert = readFileSync(certPath, "utf8");

const providerConfig = {
  provider_id: provider,
  kind: "saml",
  display: "Dev SAML",
  enabled: true,
  public: true,
  config: {
    type: "saml-v4",
    entryPoint: `${idpUrl}/saml/sso`,
    idpIssuer: issuer,
    idpCert: cert,
    issuer: spEntityId,
    audience: spEntityId,
    callbackUrl: acsUrl,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
  },
};

console.log("\nCoCalc SAML provider config for Admin > SSO Providers:\n");
console.log(JSON.stringify(providerConfig, null, 2));
console.log(`\nIdP metadata URL: ${idpUrl}/metadata`);
console.log(`Start login at:   ${cocalcUrl}/auth/${provider}`);
console.log(`Dev files:        ${workdir}\n`);

if (printOnly) {
  process.exit(0);
}

const child = spawn(
  "pnpm",
  [
    "dlx",
    "saml-idp@1.2.1",
    "--host",
    host,
    "--port",
    `${port}`,
    "--issuer",
    issuer,
    "--acsUrl",
    acsUrl,
    "--audience",
    spEntityId,
    "--serviceProviderId",
    spEntityId,
    "--cert",
    certPath,
    "--key",
    keyPath,
    "--configFile",
    configPath,
  ],
  { stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 0);
});
