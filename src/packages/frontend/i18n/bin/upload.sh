#!/usr/bin/env bash
set -euo pipefail

. ./i18n/bin/common.sh
check_api_key

# Give up on the auto-translation jobs rather than polling forever.
AUTO_TRANSLATE_TIMEOUT_SECONDS=1800

# The English language is always used directly from the default strings.
# During upload, any changes are overwritten as well.
if ! simplelocalize upload \
    --apiKey "$SIMPLELOCALIZE_KEY" \
    --languageKey en \
    --uploadFormat simplelocalize-json \
    --overwrite \
    --uploadPath ./i18n/extracted.json; then
    echo "Error: upload failed. Not starting auto-translation." >&2
    exit 1
fi

# Trigger automatic translations for all new messages.
#
# This endpoint fans out over every configured language before it answers, so
# it routinely takes minutes -- far longer than the default per-request cap.
echo "Started automatic translation for that many languages:"
SIMPLELOCALIZE_MAX_TIME=900
if ! response=$(simplelocalize_api POST \
    'https://api.simplelocalize.io/api/v2/jobs/auto-translate' \
    --header 'accept: application/json' \
    --header 'Content-Type: application/json' \
    --data '{"options": []}'); then
    echo "Error: could not start auto-translation." >&2
    echo "Note: the upload above did succeed, so the English source is already updated." >&2
    exit 1
fi
SIMPLELOCALIZE_MAX_TIME=60
echo "$response" | jq '.data|length'

echo "Waiting for auto-translation jobs to complete..."

# Wait for all auto-translation jobs to complete.
#
# Every exit from this loop must be justified by a response we actually parsed.
# Deriving the pending count by subtraction used to mean an unparseable response
# yielded 0 and printed the success message: an outage looked like a clean run.
# A FAILED job also used to keep the loop spinning forever, since it counted as
# active but was filtered out of the list of languages being waited on.
started=$SECONDS
while true; do
    sleep 3

    if [ $((SECONDS - started)) -gt "$AUTO_TRANSLATE_TIMEOUT_SECONDS" ]; then
        echo "Error: auto-translation still incomplete after ${AUTO_TRANSLATE_TIMEOUT_SECONDS}s. Giving up." >&2
        echo "Check the job list at https://simplelocalize.io before re-running." >&2
        exit 1
    fi

    if ! jobs_response=$(simplelocalize_api GET \
        'https://api.simplelocalize.io/api/v1/jobs' \
        --header 'accept: application/json'); then
        echo "Error: could not read job status; auto-translation state is unknown." >&2
        exit 1
    fi

    # A response we cannot parse is an error, never "nothing left to do".
    if ! counts=$(echo "$jobs_response" | jq -e -r '
            .data as $d
            | [($d | map(select(.state == "SUCCESS")) | length),
               ($d | map(select(.state == "FAILED")) | length),
               ($d | length)]
            | @tsv
        ' 2>/dev/null); then
        echo "Error: unexpected response from the jobs API:" >&2
        echo "$jobs_response" >&2
        exit 1
    fi

    IFS=$'\t' read -r success_jobs failed_jobs total_jobs <<<"$counts"
    pending_jobs=$((total_jobs - success_jobs - failed_jobs))

    if [ "$pending_jobs" -eq 0 ]; then
        if [ "$failed_jobs" -gt 0 ]; then
            echo "Error: $failed_jobs auto-translation job(s) FAILED:" >&2
            echo "$jobs_response" | jq -r '.data[] | select(.state == "FAILED")' >&2
            exit 1
        fi
        echo "✓ All $success_jobs auto-translation job(s) completed!"
        break
    fi

    # Cosmetic only -- never let this abort the wait.
    pending_langs=$(echo "$jobs_response" |
        jq -r '.data[] | select(.state != "SUCCESS" and .state != "FAILED") | .metadata.targetLanguage // .metadata.targetProjectLanguage' |
        tr '\n' ' ') || pending_langs="?"
    echo "  $pending_jobs job(s) still running: $pending_langs"
done
