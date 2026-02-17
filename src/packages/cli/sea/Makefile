
# Makefile for macOS SEA signing flow (mirrors plus/launchpad defaults)

APP_NAME       ?= cocalc-cli
VERSION        ?= $(shell node -p "require('../package.json').version")
TEAM_ID        ?= BVF94G2MB4
PROFILE        ?= notary-profile

# Identities exactly as shown by `security find-identity -v -p codesigning`
DEV_APP_ID     ?= Developer ID Application: William STEIN ($(TEAM_ID))
DEV_INST_ID    ?= Developer ID Installer: William STEIN ($(TEAM_ID))

.SHELLFLAGS := -euo pipefail -c

.PHONY: help signed-tar show-ids

help:
	@echo "Targets:"
	@echo "  make signed-tar  # build SEA artifact signed with Developer ID defaults"
	@echo "  make show-ids    # list available signing identities"

show-ids:
	security find-identity -v -p codesigning login.keychain-db || true

signed-tar:
	@echo "→ Build signed SEA artifact"
	COCALC_CLI_SIGN_ID="$(DEV_APP_ID)" \
	COCALC_CLI_ENTITLEMENTS="entitlements.plist" \
	./build-sea.sh
