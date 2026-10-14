#!/usr/bin/env bash
# The engine's PITR sentinel verdict, without a restore: the function on its
# own (loaded from the engine's source, which runs a restore when imported),
# and that its call in the readiness loop is outside any try, so a missed
# target fails the drill at once instead of being retried until the deadline.
# Run: bash bay-restore-engine.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 - "${SCRIPT_DIR}/bay-restore-engine.py" <<'EOF'
import ast, sys

path = sys.argv[1]
source = open(path, encoding="utf-8").read()
tree = ast.parse(source, path)
wanted = {"PitrSentinelError", "pitr_sentinels_reached"}
nodes = [n for n in tree.body if getattr(n, "name", None) in wanted]
assert {n.name for n in nodes} == wanted, "engine lacks " + str(wanted)
scope = {}
exec(compile(ast.Module(body=nodes, type_ignores=[]), path, "exec"), scope)
reached, error = scope["pitr_sentinels_reached"], scope["PitrSentinelError"]

def fails(*args, message):
    try:
        reached(*args)
    except error as err:
        assert message in str(err), str(err)
        return
    raise AssertionError("no failure for " + str(args))

# Still recovering: wait, whatever has been replayed so far.
assert reached(0, 0, True) is False
assert reached(1, 0, True) is False
# Promoted between the two sentinels: the target was hit.
assert reached(1, 0, False) is True
# Promoted before the pre sentinel (a target that precedes it): final.
fails(0, 0, False, message="without the pre-target sentinel")
fails(0, 1, False, message="without the pre-target sentinel")
# Replayed past the target: final, in or out of recovery.
fails(1, 1, True, message="crossed the requested target")
fails(1, 1, False, message="crossed the requested target")

# Its call must not sit inside a try, whose except would swallow the error.
def calls_inside_try(node, inside=False):
    found = []
    for child in ast.iter_child_nodes(node):
        child_inside = inside or isinstance(child, ast.Try)
        if (isinstance(child, ast.Call) and getattr(child.func, "id", None) == "pitr_sentinels_reached"):
            found.append((child.lineno, inside))
        found += calls_inside_try(child, child_inside)
    return found

# The whole engine runs inside one top-level try that reports the failure;
# only tries below it count.
top = [n for n in tree.body if isinstance(n, ast.Try)]
assert top, "engine has no top-level try"
calls = [c for t in top for b in t.body for c in calls_inside_try(b, isinstance(b, ast.Try))]
assert calls, "pitr_sentinels_reached is never called"
assert not any(inside for _, inside in calls), "called inside a try at lines " + str([l for l, i in calls if i])
EOF
echo "bay-restore-engine tests passed"
