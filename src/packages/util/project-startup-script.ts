/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PROJECT_STARTUP_SCRIPT_PATH = ".local/share/cocalc/startup.sh";
export const PROJECT_STARTUP_LOG_PATH = ".local/share/cocalc/startup.log";
export const PROJECT_STARTUP_ERR_PATH = ".local/share/cocalc/startup.err";

export const PROJECT_STARTUP_SCRIPT_TEMPLATE = `#!/usr/bin/env bash
# CoCalc project startup script.
#
# This script runs every time the project starts. Projects can stop when idle,
# during host maintenance, or after a restart; put lightweight setup commands
# here to recreate the services or environment your project needs.
#
# Output from this script is written beside it:
#   ~/.local/share/cocalc/startup.log
#   ~/.local/share/cocalc/startup.err
#
# Keep startup fast. If you start a long-running process, run it in the
# background and redirect its output.
#
# Examples:
#   export MY_SERVICE_PORT=8000
#   python -m http.server 8000 > ~/.local/share/cocalc/http.log 2>&1 &
`;
