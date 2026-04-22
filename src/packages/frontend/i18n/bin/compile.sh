#!/usr/bin/env bash
. ./i18n/bin/common.sh

# It was necessary to write a custom formatter (see formatter.js) – not clear why, but it works. It's just a trivial mapping.
# "--ast" this is the main point of compiling: we use ICU messages, which no longer need to be parsed each time.
# This compile step is called by the `pnpm build` step as well, hence there is no need to keep the compiled files in the sources.

# Each language is compiled into a separate file – this allows for dynamic imports.
node ./i18n/bin/run-for-each-lang.js \
  --label compile \
  --item-label compiling \
  --langs "$LANGS" \
  -- pnpm exec formatjs compile \
    --ast \
    --format i18n/formatter.js \
    --out-file "./i18n/trans/{lang}.compiled.json" \
    "./i18n/trans/{lang}.json"
