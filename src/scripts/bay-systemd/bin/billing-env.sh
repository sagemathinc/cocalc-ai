#!/usr/bin/env bash

# Older deployments enabled billing in the hub unit's systemd drop-in rather
# than the shared bay environment. Keep the executor and readiness gate aligned
# with that effective setting; never evaluate or log the rest of the unit env.
if [[ ! -v COCALC_BILLING_AUTHORITY_ENABLED ]]; then
  billing_unit_env="$(timeout --kill-after=2s 5s systemctl show \
    --property=Environment --value cocalc-bay-hub@1.service)" || {
    bay_log 'unable to determine legacy hub billing configuration'
    exit 1
  }
  billing_quoted_setting='(^|[[:space:]])"COCALC_BILLING_AUTHORITY_ENABLED=([^"]*)"([[:space:]]|$)'
  billing_setting='(^|[[:space:]])COCALC_BILLING_AUTHORITY_ENABLED=([^"[:space:]]*)([[:space:]]|$)'
  if [[ "$billing_unit_env" =~ $billing_quoted_setting ]]; then
    export COCALC_BILLING_AUTHORITY_ENABLED="${BASH_REMATCH[2]}"
  elif [[ "$billing_unit_env" =~ $billing_setting ]]; then
    export COCALC_BILLING_AUTHORITY_ENABLED="${BASH_REMATCH[2]}"
  else
    export COCALC_BILLING_AUTHORITY_ENABLED=0
  fi
  unset billing_unit_env billing_setting billing_quoted_setting
fi

# Match the authoritative Node config parser, including JavaScript whitespace.
billing_enabled="$("$COCALC_BAY_NODE_BIN" "${SCRIPT_DIR}/billing-probe.js" enabled)"
export COCALC_BILLING_AUTHORITY_ENABLED="$billing_enabled"
unset billing_enabled
