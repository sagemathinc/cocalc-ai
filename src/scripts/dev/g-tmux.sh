#!/usr/bin/env bash

echo "Spawning tmux windows with: hub, database, rspack or memory monitor..."
export DEBUG_CONSOLE='no'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

tmux new-session -d -s mysession
tmux new-window -t mysession:1
tmux new-window -t mysession:2
sleep 2
tmux send-keys -t mysession:0 "cd '${SRC_ROOT}' && '${SCRIPT_DIR}/g.sh'" C-m
sleep 2
tmux send-keys -t mysession:1 "cd '${SRC_ROOT}' && pnpm database" C-m

if [ -n "$NO_RSPACK_DEV_SERVER" ]; then
    sleep 2
    tmux send-keys -t mysession:2 "cd '${SRC_ROOT}' && pnpm rspack" C-m
fi

tmux attach -t mysession:1
