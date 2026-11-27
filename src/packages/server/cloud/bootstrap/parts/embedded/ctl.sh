#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-status}"
shift || true
RUNTIME_ROOT="__RUNTIME_ROOT__"
bin="$RUNTIME_ROOT/bin/project-host"
pid_file="/mnt/cocalc/data/daemon.pid"
rootctl="__ROOTCTL__"
case "${cmd}" in
  start|ensure|restart|stop)
    exec sudo -n "${rootctl}" "${cmd}" "$@"
    ;;
  status)
    pid=""
    if [ -r "${pid_file}" ]; then
      pid="$(cat "${pid_file}" 2>/dev/null || true)"
    elif command -v sudo >/dev/null 2>&1; then
      pid="$(sudo -n cat "${pid_file}" 2>/dev/null || true)"
    fi
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      echo "project-host running (pid ${pid})"
    else
      echo "project-host not running"
      exit 1
    fi
    ;;
  doctor)
    exec sudo -n "${rootctl}" doctor "$@"
    ;;
  *)
    echo "usage: ${0} {start|stop|restart|ensure|status|doctor}" >&2
    exit 2
    ;;
esac
