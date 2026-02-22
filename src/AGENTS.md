# AGENTS.md, CLAUDE.md and GEMINI.md

This file provides guidance to Claude Code (claude.ai/code), Gemini CLI (https://github.com/google-gemini/gemini-cli) and OpenAI Codex when working with code in this repository.

# CoCalc Source Repository

- This is the source code of CoCalc-ai in a Git repository
- It is a complex TypeScript web application
- CoCalc is organized as a monorepository (multi-packages) in the subdirectory "./packages"
- The packages are managed as a pnpm workspace in "./packages/pnpm-workspace.yaml"

## Code Style

- Run `prettier -w [filename]` after modifying a file
- Use ES modules (import/export) syntax, not CommonJS (require)
- Use the `COLORS` dictionary from `@cocalc/util/theme` for color values.
- Use `getLogger`for logging (check usage in the package your modifying for how to import this). Do not use `console.log`, except for temporary debugging. 

## Development Commands

### Essential Commands

- `pnpm build-dev` - Build all packages for development
- `pnpm clean` - Clean all `node_modules` and `dist` directories
- `pnpm test` - Run full test suite
- `pnpm depcheck` - Check for dependency issues
- `pnpm tsc` at top level (the src directory) to build all TypeScript; in `src/packages/[package_name]` use `pnpm tsc --build` for a fast typecheck. `pnpm build` is fine when it only runs `tsc`, but avoid it for packages like `next` or `static` where `build` runs full bundlers.

### Package-Specific Commands

- `cd packages/[package] && pnpm build` - Build a specific package
  - For packages/next and packages/static, run `cd packages/[package] && pnpm build-dev`
  - For a quick typecheck in any package, prefer `pnpm tsc --build`
- `cd packages/[package] && pnpm test` - Run tests for a specific package

### Dependency Management

Package versions must be uniform across all CoCalc packages in the monorepo.

When updating npm packages:

- **Always update associated `@types/[name]` packages** when updating an npm package `[name]` if `@types/[name]` is installed
- Run `pnpm version-check` from the root directory (`cocalc/src/`) to verify version consistency
- Run `pnpm install` after updating dependencies in any package
- Example: When updating `pg` from `^8.7.1` to `^8.16.3`, also update `@types/pg` from `^8.6.1` to `^8.16.0` in **all packages** that use them

## Architecture Overview

See ../docs/ for extensive documentation about the architecture of cocalc.

### Package Structure

CoCalc is organized as a monorepo with key packages, including these:

- **frontend** - React/TypeScript frontend application using Redux-style stores and actions
- **backend** - Node.js backend services and utilities
- **hub** - Main server orchestrating the entire system
- **database** - PostgreSQL database layer with queries and schema
- **util** - Shared utilities and types used across packages
- **comm** - Communication layer including WebSocket types
- **conat** - CoCalc's container/compute orchestration system
- **sync** - Real-time synchronization system for collaborative editing
- **project** - Project-level services and management
- **static** - Static assets and build configuration
- **next** - Next.js server components

### Key Architectural Patterns

#### Frontend Architecture

- **Redux-style State Management**: Uses custom stores and actions pattern (see `packages/frontend/app-framework/actions-and-stores.ts`)
- **Typescript React Components**: All frontend code is TypeScript and we use react functions.
- **Store System**: Each feature has its own store/actions (AccountStore, BillingStore, etc.)
- **WebSocket Communication**: Real-time communication with backend via WebSocket messages via conat (src/packages/conat)

#### Backend Architecture (Cocalc Launchpad)

- **PostgreSQL Database**: Primary data store with custom querying system
- **Conat System**: Messaging and routing for projects and hosts
- **Database Access**: Use `getPool()` from `@cocalc/database/pool` for direct database queries in hub/backend code. Example: `const pool = getPool(); const { rows } = await pool.query('SELECT * FROM table WHERE id = $1', [id]);`

#### Communication Patterns

- **API Schema**: http API endpoints in `packages/next/pages/api/v2/` use Zod schemas in `packages/next/lib/api/schema/` for validation. **Avoid these** in favor of the rpc endpoints defined in packages/conat/hub/api
- **Conat Frontend &lt;--&gt; Hub Communication**: CoCalc uses a custom pub/sub system called "Conat" (inspired by NATS.io) for most communication:
  1. **Frontend ConatClient** (`packages/frontend/conat/client.ts`): Manages WebSocket connection to hub, handles authentication, reconnection, and provides API interfaces
  2. **Core Protocol** (`packages/conat/core/client.ts`): NATS-like pub/sub/request/response messaging with automatic chunking, and delivery confirmation
  3. **Hub API Structure** (`packages/conat/hub/api/`): Typed interfaces for different services (system, projects, db, purchases, jupyter) that map function calls to conat subjects
  4. **Message Flow**: Frontend calls like `hub.projects.setQuotas()` → ConatClient.callHub() → conat request to subject `hub.account.{account_id}.api` → Hub API dispatcher → actual service implementation
  5. **Subjects**: Messages are routed using hierarchical subjects like `hub.account.{uuid}.{service}` or `project.{uuid}.{service}`

### Database Schema

- Comprehensive schema in `packages/util/db-schema`
- Query abstractions in `packages/database/postgres/`

### Testing

- **Jest**: Primary testing framework
- **ts-jest**: TypeScript support for Jest
- **jsdom**: Browser environment simulation for frontend tests
- **playwright**: Full browser environment
- Test files use `.test.ts` or `.spec.ts` extensions
- Each package has its own jest.config.js

### Import Patterns

- Use absolute imports with `@cocalc/` prefix for cross-package imports
- Example: `import { cmp } from "@cocalc/util/misc"`
- Type imports: `import type { Foo } from "./bar"`

# Workflow

- Be sure to build when you're done making a series of code changes
- Prefer running single tests, and not the whole test suite, for performance

## Git Workflow

- Prefix git commits with the package and general area. e.g. 'frontend/latex: ...' if it concerns latex editor changes in the packages/frontend/... code.

## React-intl / Internationalization (i18n)

CoCalc uses react-intl for internationalization with SimpleLocalize as the translation platform.

### Architecture Overview

- **Library**: Uses `react-intl` library with `defineMessages()` and `defineMessage()`
- **Default Language**: English uses `defaultMessage` directly - no separate English translation files
- **Supported Languages**: 19+ languages including German, Chinese, Spanish, French, Italian, Dutch, Russian, Japanese, Portuguese, Korean, Polish, Turkish, Hebrew, Hindi, Hungarian, Arabic, and Basque
- **Translation Platform**: SimpleLocalize with OpenAI GPT-4o for automatic translations

### Usage Patterns

- **TSX Components**: `<FormattedMessage id="..." defaultMessage="..." />`
- **Data Structures**: `defineMessage({id: "...", defaultMessage: "..."})`
- **Programmatic Use**: `useIntl()` hook + `intl.formatMessage()`
- **Non-React Contexts**: `getIntl()` function

### Translation Workflow

See ../docs/translation.md