#!/bin/bash
# Delete specific translation keys from SimpleLocalize
# Usage: ./delete.sh key1 [key2 key3 ...]

. ./i18n/bin/common.sh

if [ $# -eq 0 ]; then
    echo "Usage: $0 key1 [key2 key3 ...]"
    echo "Delete one or more translation keys from SimpleLocalize"
    echo ""
    echo "Example:"
    echo "  $0 labels.masked_files"
    echo "  $0 labels.masked_files account.sign-out.button.title"
    exit 1
fi

check_api_key

echo "Deleting translation keys from SimpleLocalize..."

deleted=0
failed=0
for key in "$@"; do
    if simplelocalize_api DELETE \
        "https://api.simplelocalize.io/api/v1/translation-keys?key=$key" >/dev/null; then
        echo "  deleted '$key'"
        deleted=$((deleted + 1))
    else
        echo "  FAILED  '$key'" >&2
        failed=$((failed + 1))
    fi
done

echo
if [ "$failed" -gt 0 ]; then
    echo "Deleted $deleted key(s), but $failed failed -- see the errors above." >&2
    echo "Nothing else was changed. Fix the cause and re-run for the failed keys." >&2
    exit 1
fi

echo "Done! Deleted $deleted key(s). Now you should run:"
echo "  pnpm i18n:update    (to upload, translate, download and compile)"
