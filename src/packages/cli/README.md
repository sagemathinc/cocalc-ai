# @cocalc/cli

Commander-based CoCalc CLI.

## Build

```bash
pnpm --dir src/packages/cli build
```

## Run

```bash
node src/packages/cli/dist/bin/cocalc.js --help
```

## Phase 0 Commands

- `workspace create`
- `workspace start --wait`
- `workspace exec`
- `workspace ssh`
- `workspace move --host --wait`
- `workspace copy-path --wait`
- `workspace snapshot create`
- `workspace snapshot list`
- `host resolve-connection`
- `host issue-http-token`
- `workspace proxy url`
- `workspace proxy curl`
