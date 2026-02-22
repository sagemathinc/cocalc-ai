# Translation Workflow

**For new translation keys:**

1. Add the translation to source code (e.g., `packages/frontend/i18n/common.ts`)
2. Run `pnpm i18n:extract` - updates `extracted.json` from source code
3. Run `pnpm i18n:upload` - sends new strings to SimpleLocalize
4. New keys are automatically translated to all languages
5. Run `pnpm i18n:download` - fetches translations
6. Run `pnpm i18n:compile` - compiles translation files

**For editing existing translation keys:**
Same flow as above, but **before 3. i18n:upload**, delete the key. Only new keys are auto-translated. `pnpm i18n:delete [id]`.

### Translation File Structure

- `packages/frontend/i18n/README.md` - detailed documentation
- `packages/frontend/i18n/common.ts` - shared translation definitions (labels, menus, editor, jupyter, etc.)
- `packages/frontend/i18n/extracted.json` - auto-extracted messages from source code
- `packages/frontend/i18n/trans/[locale].json` - downloaded translations from SimpleLocalize
- `packages/frontend/i18n/trans/[locale].compiled.json` - compiled translation files for runtime
- `packages/frontend/i18n/index.ts` - exports and locale loading logic
