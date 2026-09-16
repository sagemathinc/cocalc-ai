# Package configuration notes

## Current overrides

Workspace overrides are configured in [pnpm-workspace.yaml](./pnpm-workspace.yaml),
under `overrides`. Read the current constraints and lockfile before changing
a dependency; the old notes below do not identify the active override set.

## Historical override notes

The following records earlier Mistral and LangChain work. The referenced
Mistral fork is not an instruction to remove a current workspace override.

- `@mistralai/mistralai`
  - Overrides the global `fetch` command and we fix this essentially by merging in https://github.com/mistralai/client-js/pull/42
  - Remove the override and delete our fork once https://github.com/mistralai/client-js/issues/44 is fixed
  - The extra `node_modules/*` prefix is because otherwise the symlink pointed to the wrong dir level. Must be a bug in pnpm!
- `@langchain/core`
  - Pinning its version is strongly recommended: https://js.langchain.com/docs/get_started/installation#installing-integration-packages
