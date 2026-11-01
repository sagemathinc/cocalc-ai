#!/usr/bin/python3 -I
"""Kernel-level check of a podman-format seccomp profile, run by hand on an
x86_64 Linux host (it needs libseccomp.so.2, nothing else).

    python3 -I kernel_check.py cocalc-project-seccomp.json [CAPS]
    python3 -I kernel_check.py --diff base-seccomp.json cocalc-project-seccomp.json [CAPS]

It loads the profile through libseccomp the way crun does (non-exact
seccomp_rule_add_array, podman's includes/excludes by capability), reports
rule-add failures and the BPF size, then installs the filter in a forked
child with no_new_privs and issues raw syscalls, including high-word
truncation cases. --diff runs an argument grid under both profiles and fails
on any difference that isn't one of the intended ones. Environment:
SECCOMP_LIB picks the libseccomp shared object (the hosts' crun uses noble's
2.5.5); SECCOMP_SUBARCHES (default "x86,x32") lists the sub-architectures to
add (the hosts' crun behaves as native-only: set it empty)."""

import ctypes
import ctypes.util
import errno
import json
import os
import socket
import sys
import tempfile

lib = ctypes.CDLL(os.environ.get("SECCOMP_LIB", "libseccomp.so.2"), use_errno=True)
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long

SCMP_ACT_ALLOW = 0x7FFF0000
OPS = {"SCMP_CMP_NE": 1, "SCMP_CMP_LT": 2, "SCMP_CMP_LE": 3, "SCMP_CMP_EQ": 4,
       "SCMP_CMP_GE": 5, "SCMP_CMP_GT": 6, "SCMP_CMP_MASKED_EQ": 7}
PR_SET_NO_NEW_PRIVS = 38
SYS = {"socket": 41, "setsockopt": 54, "io_uring_setup": 425, "getpid": 39}


class ArgCmp(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]


lib.seccomp_init.restype = ctypes.c_void_p
lib.seccomp_init.argtypes = [ctypes.c_uint32]
lib.seccomp_arch_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
lib.seccomp_arch_resolve_name.restype = ctypes.c_uint32
lib.seccomp_arch_resolve_name.argtypes = [ctypes.c_char_p]
lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                       ctypes.c_uint, ctypes.POINTER(ArgCmp)]
lib.seccomp_rule_add_exact_array.argtypes = lib.seccomp_rule_add_array.argtypes
lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
lib.seccomp_load.argtypes = [ctypes.c_void_p]


def errno_action(value: int) -> int:
    return 0x00050000 | (value & 0xFFFF)


def action_of(entry: dict, default_errno: int) -> int:
    action = entry["action"]
    if action == "SCMP_ACT_ALLOW":
        return SCMP_ACT_ALLOW
    if action == "SCMP_ACT_ERRNO":
        return errno_action(entry.get("errnoRet", errno.EPERM))
    raise ValueError(action)


def applies(entry: dict, caps: set[str], arch: str) -> bool:
    inc, exc = entry.get("includes") or {}, entry.get("excludes") or {}
    if inc.get("caps") and not set(inc["caps"]) <= caps:
        return False
    if exc.get("caps") and set(exc["caps"]) & caps:
        return False
    if inc.get("arches") and arch not in inc["arches"]:
        return False
    if exc.get("arches") and arch in exc["arches"]:
        return False
    if inc.get("minKernel") or exc.get("minKernel"):
        pass  # podman checks the running kernel; all our kernels are new
    return True


def build(profile: dict, caps: set[str], exact: bool):
    ctx = lib.seccomp_init(errno_action(profile.get("defaultErrnoRet", errno.ENOSYS)))
    subarches = os.environ.get("SECCOMP_SUBARCHES", "x86,x32")
    for sub in [a for a in subarches.split(",") if a]:
        rc = lib.seccomp_arch_add(ctx, lib.seccomp_arch_resolve_name(sub.encode()))
        if rc not in (0, -errno.EEXIST):
            raise OSError(-rc, f"arch {sub}")
    add = lib.seccomp_rule_add_exact_array if exact else lib.seccomp_rule_add_array
    rules = failures = 0
    for entry in profile["syscalls"]:
        if not applies(entry, caps, "amd64"):
            continue
        args = entry.get("args") or []
        arr = (ArgCmp * max(1, len(args)))()
        for i, a in enumerate(args):
            arr[i] = ArgCmp(a["index"], OPS[a["op"]], a["value"], a.get("valueTwo", 0))
        for name in entry["names"]:
            nr = lib.seccomp_syscall_resolve_name(name.encode())
            if nr < 0:
                continue  # unknown to this libseccomp: crun skips it too
            rc = add(ctx, action_of(entry, profile.get("defaultErrnoRet", 38)), nr, len(args), arr)
            rules += 1
            if rc != 0:
                failures += 1
                if failures <= 5:
                    print(f"rule-add-failed name={name} rc={rc} nargs={len(args)}", flush=True)
    return ctx, rules, failures


def bpf_size(ctx) -> int:
    with tempfile.TemporaryFile() as f:
        rc = lib.seccomp_export_bpf(ctx, f.fileno())
        if rc != 0:
            raise OSError(-rc, "export")
        f.seek(0, 2)
        return f.tell() // 8


def raw(nr: int, *args: int) -> tuple[int, int]:
    ctypes.set_errno(0)
    values = [ctypes.c_long(a if a < 2**63 else a - 2**64) for a in args]
    ret = libc.syscall(ctypes.c_long(nr), *values)
    return ret, ctypes.get_errno()


CASES = [
    # (label, syscall, args, expected: "ok" | errno name)
    ("socket tcp4", "socket", (2, 1, 0), "ok"),
    ("socket tcp6", "socket", (10, 1, 0), "ok"),
    ("socket udp4", "socket", (2, 2, 0), "ok"),
    ("socket unix", "socket", (1, 1, 0), "ok"),
    ("socket netlink route", "socket", (16, 3, 0), "ok"),
    ("socket mptcp4", "socket", (2, 1, 262), "EPERM"),
    ("socket mptcp6", "socket", (10, 1, 262), "EPERM"),
    ("socket mptcp4 hi-bits 0x1_00000106", "socket", (2, 1, 0x1_00000106), "EPERM"),
    ("socket mptcp4 hi-bits 0xffffffff_00000106", "socket", (2, 1, 0xFFFFFFFF_00000106), "EPERM"),

    ("socket netlink audit (no CAP_AUDIT_WRITE)", "socket", (16, 3, 9), "EINVAL"),
    ("socket proto hi-bits non-mptcp 0x1_00000000", "socket", (2, 1, 0x1_00000000), "ENOSYS"),
]


def setsockopt_cases(fd4: int, fd6: int):
    one = ctypes.c_int(1)
    tos = ctypes.c_int(0x10)
    opt = ctypes.create_string_buffer(b"\x01\x01\x01\x00", 4)  # NOPs + EOL
    p_tos, p_opt, p_one = (ctypes.addressof(tos), ctypes.addressof(opt), ctypes.addressof(one))
    return [
        ("setsockopt IP_TOS v4", (fd4, 0, 1, p_tos, 4), "ok"),
        ("setsockopt SO_REUSEADDR", (fd4, 1, 2, p_one, 4), "ok"),
        ("setsockopt TCP_NODELAY", (fd4, 6, 1, p_one, 4), "ok"),
        ("setsockopt IPV6_V6ONLY", (fd6, 41, 26, p_one, 4), "ok"),
        ("setsockopt IP_OPTIONS v4", (fd4, 0, 4, p_opt, 4), "EPERM"),
        ("setsockopt IP_RETOPTS v4", (fd4, 0, 7, p_opt, 4), "EPERM"),
        ("setsockopt IP_OPTIONS v6 socket (v4-mapped path)", (fd6, 0, 4, p_opt, 4), "EPERM"),
        ("setsockopt IP_OPTIONS opt hi-bits 0x1_00000004", (fd4, 0, 0x1_00000004, p_opt, 4), "EPERM"),
        ("setsockopt IP_RETOPTS opt hi-bits 0x1_00000007", (fd4, 0, 0x1_00000007, p_opt, 4), "EPERM"),
        ("setsockopt IP_OPTIONS level hi-bits 0x1_00000000", (fd4, 0x1_00000000, 4, p_opt, 4), "EPERM"),
        ("setsockopt IP_OPTIONS both hi-bits", (fd4, 0xFFFFFFFF_00000000, 0xFFFFFFFF_00000004, p_opt, 4), "EPERM"),
        ("setsockopt IP_TOS opt hi-bits (not a deny value)", (fd4, 0, 0x1_00000001, p_tos, 4), "ENOSYS"),
    ]


def run_cases(ctx) -> list[str]:
    """In a forked child: load the filter, run the cases, report lines."""
    fd4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM).detach()
    fd6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM).detach()
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        out = []
        try:
            if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
                raise OSError(ctypes.get_errno(), "nnp")
            rc = lib.seccomp_load(ctx)
            if rc != 0:
                raise OSError(-rc, "load")
            for label, name, args, want in CASES:
                ret, err = raw(SYS[name], *args)
                got = "ok" if ret >= 0 else errno.errorcode.get(err, str(err))
                if ret >= 0:
                    os.close(ret)
                out.append(f"{'PASS' if got == want else 'FAIL'} {label}: got={got} want={want}")
            for label, args, want in setsockopt_cases(fd4, fd6):
                ret, err = raw(SYS["setsockopt"], *args)
                got = "ok" if ret >= 0 else errno.errorcode.get(err, str(err))
                out.append(f"{'PASS' if got == want else 'FAIL'} {label}: got={got} want={want}")
            ret, err = raw(SYS["io_uring_setup"], 1, 0)
            got = "ok" if ret >= 0 else errno.errorcode.get(err, str(err))
            out.append(f"{'PASS' if got in ('ENOSYS', 'EPERM') else 'FAIL'} io_uring_setup: got={got} want=ENOSYS|EPERM")
        except BaseException as e:  # noqa
            out.append(f"FAIL harness: {type(e).__name__} {e}")
        os.write(w, "\n".join(out).encode())
        os._exit(0)
    os.close(w)
    data = b""
    while True:
        chunk = os.read(r, 65536)
        if not chunk:
            break
        data += chunk
    os.waitpid(pid, 0)
    return data.decode().splitlines()


def main(argv):
    profile = json.load(open(argv[1]))
    caps = set(argv[2].split(",")) if len(argv) > 2 and argv[2] else set()
    for exact in (False, True):
        ctx, rules, failures = build(profile, caps, exact)
        print(f"build exact={exact} rules={rules} failures={failures} bpf_instructions={bpf_size(ctx)}", flush=True)
    ctx, _, _ = build(profile, caps, False)
    lines = run_cases(ctx)
    for line in lines:
        print(line)
    print(f"summary pass={sum(l.startswith('PASS') for l in lines)} fail={sum(l.startswith('FAIL') for l in lines)}")
    return 0




# --- differential: base vs generated over an argument grid -------------------

def grid():
    domains = list(range(0, 46)) + [0x1_00000002, 0x1_00000010, 0xFFFFFFFF]
    types = [1, 2, 3, 5]
    protos = [0, 1, 6, 9, 17, 58, 132, 136, 255, 256, 261, 262, 263, 768, 65535, 65536,
              0x1_00000000, 0x1_00000009, 0x1_00000106, 0xFFFFFFFF]
    for d in domains:
        for t in types:
            for p in protos:
                yield ("socket", (d, t, p))
    levels = [0, 1, 6, 17, 41, 58, 132, 255, 263, 270, 282, 65535, 65536,
              0x1_00000000, 0x1_00000001, 0xFFFFFFFF_00000000]
    optnames = list(range(0, 71)) + [255, 65535, 65536, 0x1_00000004, 0x1_00000007, 0x1_00000001]
    for which in ("v4", "v6"):
        for level in levels:
            for opt in optnames:
                yield ("setsockopt-" + which, (level, opt))


def outcomes(ctx) -> dict:
    """Runs the grid under ctx in a forked child; returns case -> result."""
    fd4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM).detach()
    fd6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM).detach()
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        res = {}
        try:
            if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
                raise OSError(ctypes.get_errno(), "nnp")
            rc = lib.seccomp_load(ctx)
            if rc != 0:
                raise OSError(-rc, "load")
            for kind, args in grid():
                if kind == "socket":
                    ret, err = raw(SYS["socket"], *args)
                else:
                    fd = fd4 if kind.endswith("v4") else fd6
                    # NULL optval, optlen 0: no state change beyond clearing.
                    ret, err = raw(SYS["setsockopt"], fd, args[0], args[1], 0, 0)
                if kind == "socket" and ret >= 0:
                    os.close(ret)
                res[f"{kind}:{','.join(hex(a) for a in args)}"] = "ok" if ret >= 0 else errno.errorcode.get(err, str(err))
        except BaseException as e:  # noqa
            res["harness"] = f"{type(e).__name__} {e}"
        os.write(w, json.dumps(res).encode())
        os._exit(0)
    os.close(w)
    data = b""
    while True:
        chunk = os.read(r, 1 << 20)
        if not chunk:
            break
        data += chunk
    os.waitpid(pid, 0)
    return json.loads(data)


def expected_difference(case: str, base: str, gen: str) -> str | None:
    kind, args = case.split(":")
    vals = [int(a, 16) for a in args.split(",")]
    lo = lambda v: v & 0xFFFFFFFF  # noqa
    if kind == "socket":
        d, t, p = vals
        if lo(p) == 262 and gen == "EPERM":
            return "mptcp-refused"
        if (p >> 32 or p >= 65536) and gen == "ENOSYS":
            return "protocol-out-of-range"
    else:
        level, opt = vals
        if lo(level) == 0 and lo(opt) in (4, 7) and gen == "EPERM":
            return "ip-options-refused"
        if (level >> 32 or level >= 65536 or (lo(level) == 0 and (opt >> 32 or opt >= 65536))) and gen == "ENOSYS":
            return "arg-out-of-range"
    return None


def diff_main(base_path: str, gen_path: str, caps: set[str]) -> int:
    base = json.load(open(base_path))
    gen = json.load(open(gen_path))
    a = outcomes(build(base, caps, False)[0])
    b = outcomes(build(gen, caps, False)[0])
    if "harness" in a or "harness" in b:
        print("FAIL harness", a.get("harness"), b.get("harness"))
        return 1
    categories: dict[str, int] = {}
    unexpected = 0
    for case in a:
        if a[case] == b[case]:
            categories["same"] = categories.get("same", 0) + 1
            continue
        why = expected_difference(case, a[case], b[case])
        if why is None:
            unexpected += 1
            if unexpected <= 20:
                print(f"UNEXPECTED {case}: base={a[case]} generated={b[case]}")
        else:
            categories[why] = categories.get(why, 0) + 1
    print(f"diff cases={len(a)} unexpected={unexpected} " +
          " ".join(f"{k}={v}" for k, v in sorted(categories.items())))
    return 1 if unexpected else 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--diff":
        caps = set(sys.argv[4].split(",")) if len(sys.argv) > 4 and sys.argv[4] else set()
        sys.exit(diff_main(sys.argv[2], sys.argv[3], caps))
    sys.exit(main(sys.argv))
