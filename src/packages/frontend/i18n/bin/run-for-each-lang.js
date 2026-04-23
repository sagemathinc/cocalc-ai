#!/usr/bin/env node

const { spawn } = require("child_process");

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_DELAY_MS = 100;

function usage() {
  console.error(`Usage:
  node ./i18n/bin/run-for-each-lang.js \\
    --label <task-name> \\
    --item-label <per-language-message> \\
    --langs "<space-separated-langs>" \\
    [--concurrency 8] [--delay-ms 100] \\
    -- <command> [args...]

Use {lang} in command arguments where the locale should be substituted.`);
}

function parseInteger(value, flag) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    throw new Error("missing -- command separator");
  }

  const options = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  const config = {
    concurrency: parseInteger(
      process.env.I18N_CONCURRENCY || `${DEFAULT_CONCURRENCY}`,
      "I18N_CONCURRENCY",
    ),
    delayMs: DEFAULT_DELAY_MS,
    itemLabel: undefined,
    label: undefined,
    langs: undefined,
  };

  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    const value = options[i + 1];
    switch (option) {
      case "--concurrency":
        config.concurrency = parseInteger(value, option);
        i += 1;
        break;
      case "--delay-ms":
        config.delayMs = parseInteger(value, option);
        i += 1;
        break;
      case "--item-label":
        config.itemLabel = value;
        i += 1;
        break;
      case "--label":
        config.label = value;
        i += 1;
        break;
      case "--langs":
        config.langs = value;
        i += 1;
        break;
      default:
        throw new Error(`unknown option: ${option}`);
    }
  }

  if (!config.label) {
    throw new Error("--label is required");
  }
  if (!config.itemLabel) {
    throw new Error("--item-label is required");
  }
  if (!config.langs) {
    throw new Error("--langs is required");
  }
  if (command.length === 0) {
    throw new Error("command is required");
  }

  return {
    ...config,
    command,
    langs: config.langs.split(/\s+/).filter(Boolean),
  };
}

function substituteLang(value, lang) {
  return value.replaceAll("{lang}", lang);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runForEachLang(config) {
  const start = Date.now();
  const queue = [...config.langs];
  const children = new Set();
  let failed = false;
  let started = 0;

  const stopChildren = (signal) => {
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill(signal);
      }
    }
  };

  process.once("SIGINT", () => {
    stopChildren("SIGINT");
    process.exitCode = 130;
  });
  process.once("SIGTERM", () => {
    stopChildren("SIGTERM");
    process.exitCode = 143;
  });

  async function runOne(lang) {
    console.log(`${config.itemLabel} '${lang}'`);
    const [cmd, ...args] = config.command.map((arg) =>
      substituteLang(arg, lang),
    );

    await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: "inherit",
      });
      children.add(child);
      child.on("error", reject);
      child.on("close", (code, signal) => {
        children.delete(child);
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            signal
              ? `${config.label} '${lang}' failed with signal ${signal}`
              : `${config.label} '${lang}' failed with exit code ${code}`,
          ),
        );
      });
    });
  }

  async function worker() {
    while (!failed && queue.length > 0) {
      const lang = queue.shift();
      started += 1;
      if (started > 1 && config.delayMs > 0) {
        await sleep(config.delayMs);
      }
      try {
        await runOne(lang);
      } catch (err) {
        failed = true;
        stopChildren("SIGTERM");
        throw err;
      }
    }
  }

  console.log(
    `Running ${config.label} for ${config.langs.length} languages with concurrency ${config.concurrency}.`,
  );

  const workerCount = Math.min(config.concurrency, config.langs.length);
  try {
    await Promise.all(Array.from({ length: workerCount }, worker));
  } finally {
    const executionTime = Math.round((Date.now() - start) / 1000);
    console.log(`${config.label} completed in ${executionTime} seconds.`);
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  await runForEachLang(config);
}

main().catch((err) => {
  console.error(err.message || err);
  usage();
  process.exit(1);
});
