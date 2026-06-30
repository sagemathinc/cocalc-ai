set -euo pipefail

jupyter_prefix="${JUPYTER_PREFIX:-/opt/cocalc-julia-jupyter}"

command -v julia
command -v jupyter
julia --version
test -f /usr/local/share/jupyter/kernels/julia/kernel.json
jupyter kernelspec list | grep -q 'julia'
julia --startup-file=no -e 'using IJulia; println("IJulia OK")'
"$jupyter_prefix/bin/python" - <<'PY'
from queue import Empty
from jupyter_client import KernelManager

km = KernelManager(kernel_name="julia")
kc = None
try:
    km.start_kernel()
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=120)
    msg_id = kc.execute('println("cocalc-julia-kernel-ok")')
    saw_ok = False
    while True:
        try:
            msg = kc.get_iopub_msg(timeout=120)
        except Empty:
            raise SystemExit("timed out waiting for Julia kernel output")
        if msg.get("parent_header", {}).get("msg_id") != msg_id:
            continue
        msg_type = msg.get("header", {}).get("msg_type")
        content = msg.get("content", {})
        if msg_type == "stream" and "cocalc-julia-kernel-ok" in content.get("text", ""):
            saw_ok = True
        if msg_type == "error":
            raise SystemExit("\\n".join(content.get("traceback", [])) or content.get("ename", "Julia kernel error"))
        if msg_type == "status" and content.get("execution_state") == "idle":
            break
    if not saw_ok:
        raise SystemExit("Julia kernel did not produce expected output")
finally:
    if kc is not None:
        kc.stop_channels()
    km.shutdown_kernel(now=True)
PY
