#!/usr/bin/python3 -I
"""Derive CoCalc's project-container seccomp profile from the hosts' base
profile (private 021, item B).

The base is the hosts' /usr/share/containers/seccomp.json
(golang-github-containers-common 0.57.4+ds1-2ubuntu0.2; sha256 cc374cf2...),
which the bundled podman reads. The generator refuses any base whose
socket/setsockopt/socketcall rules differ from the ones it was reviewed
against (BASE_SOCKET_RULES and the plain-allow check), so a base change
forces a re-review.

Changes to the base, nothing else:

- setsockopt: EPERM for level IPPROTO_IP (0) with optname IP_OPTIONS (4) or
  IP_RETOPTS (7), whatever the socket family (v4-mapped IPv6 sockets
  included). Matched on the low 32 bits, because the kernel truncates these
  C ints: a caller can't slip 0x1_00000004 past the rule.
- socket: EPERM for protocol IPPROTO_MPTCP (262), on the low 32 bits. The
  base's socket semantics are otherwise kept exactly: without
  CAP_AUDIT_WRITE, (AF_NETLINK, NETLINK_AUDIT) gives EINVAL (exact 64-bit
  compare, as in the base); everything else is allowed.
- socketcall (the 32-bit multiplexer, whose arguments seccomp can't see):
  EPERM.
- The filter covers the native ABI only: the archMap keeps each
  architecture and drops its sub-architectures, so x86 (int 0x80) and x32
  system calls hit libseccomp's bad-arch action (the thread is killed with
  SIGSYS). With the sub-architectures, libseccomp maps the base's socket
  rules onto socketcall, whose real arguments sit behind a pointer, so a
  32-bit caller could still create an MPTCP socket through socketcall.
  Today's base, as the hosts load it, lets 32-bit calls through (measured
  from inside a project). This change is deliberate and stops 32-bit
  programs in projects.

Rules with different actions for the same syscall are DISJOINT by
construction. libseccomp drops a conditional rule when an unconditional
allow exists for the same syscall, evaluates overlapping conditional rules
in insertion order, and (2.5.5 and 2.6) rejects some overlaps with EEXIST,
which makes crun fail the container. So:

- the three syscalls are removed from every base rule;
- every ALLOW region is built from pieces that cannot meet any deny region:
  - masked-equality "aligned cubes" on all 64 bits, which also pin the high
    word to 0;
  - single unsigned comparisons (LT/GT) on an argument whose deny point uses
    exact 64-bit equality, as the base does.

Allow pieces cover values below 2^16 for level, optname and protocol (all
real ones are below 300; AF_PACKET's htons(ETH_P_*) are 16-bit). That keeps
the BPF program small. Values with the high word set, or at or above 2^16,
that match no deny rule fall to the profile's default action (ENOSYS)
instead of the kernel's error. Real callers sign-extend non-negative ints,
so they never set the high word.
"""

import base64
import copy
import hashlib
import json
import sys

LOW32 = 0xFFFFFFFF
ALL64 = 0xFFFFFFFFFFFFFFFF
EPERM = 1
EINVAL = 22

IPPROTO_IP = 0
IP_OPTIONS = 4
IP_RETOPTS = 7
IPPROTO_MPTCP = 262
AF_NETLINK = 16
NETLINK_AUDIT = 9
CAP_AUDIT_WRITE = "CAP_AUDIT_WRITE"
CHANGED = ("socket", "setsockopt", "socketcall")
ALLOW_LIMIT = 1 << 16  # allow pieces cover [0, ALLOW_LIMIT)

# The base's socket rules this generator reproduces (0.57.4), normalized as
# (action, errnoRet, [(index, op, value, valueTwo)], includes, excludes).
_AUDIT = {"caps": [CAP_AUDIT_WRITE]}
BASE_SOCKET_RULES = [
    ("SCMP_ACT_ERRNO", 22, [(0, "SCMP_CMP_EQ", 16, 0), (2, "SCMP_CMP_EQ", 9, 0)], {}, _AUDIT),
    ("SCMP_ACT_ALLOW", None, [(2, "SCMP_CMP_NE", 9, 0)], {}, _AUDIT),
    ("SCMP_ACT_ALLOW", None, [(0, "SCMP_CMP_NE", 16, 0)], {}, _AUDIT),
    ("SCMP_ACT_ALLOW", None, [(2, "SCMP_CMP_NE", 9, 0)], {}, _AUDIT),
    ("SCMP_ACT_ALLOW", None, [], _AUDIT, {}),
]


class BaseMismatch(Exception):
    pass


def check_base(base: dict) -> None:
    """The base must match what this generator was reviewed against."""
    socket_rules = []
    plain_allows = {"setsockopt": 0, "socketcall": 0}
    for entry in base["syscalls"]:
        names = set(entry["names"])
        if not names & set(CHANGED):
            continue
        if "socket" in names:
            if names != {"socket"}:
                raise BaseMismatch("socket shares a rule")
            socket_rules.append((
                entry["action"], entry.get("errnoRet"),
                [(a["index"], a["op"], a["value"], a.get("valueTwo", 0)) for a in entry.get("args") or []],
                entry.get("includes") or {}, entry.get("excludes") or {},
            ))
        elif (entry["action"] != "SCMP_ACT_ALLOW" or entry.get("args")
              or entry.get("includes") or entry.get("excludes")):
            # setsockopt/socketcall only ever as plain unconditional allows.
            raise BaseMismatch("setsockopt/socketcall rule shape")
        else:
            for name in names & set(plain_allows):
                plain_allows[name] += 1
    if socket_rules != BASE_SOCKET_RULES:
        raise BaseMismatch("socket rules")
    # Both must be there, exactly once: the replacement rules are only
    # right for a base that allowed them unconditionally.
    if plain_allows != {"setsockopt": 1, "socketcall": 1}:
        raise BaseMismatch("setsockopt/socketcall presence")


def cubes(lo: int, hi: int) -> list[tuple[int, int]]:
    """Aligned power-of-two blocks covering [lo, hi] (inclusive, within
    32 bits) as (mask, value) for a masked-equality compare on all 64 bits:
    each block also requires the high word to be 0."""
    out = []
    while lo <= hi:
        size = lo & -lo if lo else 1 << 32
        while size > hi - lo + 1:
            size >>= 1
        out.append((ALL64 & ~(size - 1), lo))
        lo += size
    return out


def complement_cubes(points: list[int], limit: int = ALLOW_LIMIT) -> list[tuple[int, int]]:
    """Cubes covering [0, limit) except the given points."""
    out, start = [], 0
    for p in sorted(set(points)):
        if p > start:
            out += cubes(start, p - 1)
        start = p + 1
    if start < limit:
        out += cubes(start, limit - 1)
    return out


def arg(index: int, op: str, value: int, value_two: int = 0) -> dict:
    return {"index": index, "value": value, "valueTwo": value_two, "op": op}


def masked(index: int, mask: int, value: int) -> dict:
    return arg(index, "SCMP_CMP_MASKED_EQ", mask, value)


def rule(name: str, action: str, args: list[dict], errno: int | None = None,
         includes: dict | None = None, excludes: dict | None = None, comment: str = "") -> dict:
    out = {"names": [name], "action": action, "args": args, "comment": comment,
           "includes": includes or {}, "excludes": excludes or {}}
    if errno is not None:
        out["errnoRet"] = errno
    return out


def setsockopt_rules() -> list[dict]:
    rules = []
    for opt in (IP_OPTIONS, IP_RETOPTS):
        rules.append(rule("setsockopt", "SCMP_ACT_ERRNO",
                          [masked(1, LOW32, IPPROTO_IP), masked(2, LOW32, opt)], EPERM,
                          comment="021: IP_OPTIONS/IP_RETOPTS (low 32 bits)"))
    # ALLOW: level != 0 ...
    for mask, value in complement_cubes([IPPROTO_IP]):
        rules.append(rule("setsockopt", "SCMP_ACT_ALLOW", [masked(1, mask, value)],
                          comment="021: level != IPPROTO_IP"))
    # ... or level == 0 with any other optname.
    for mask, value in complement_cubes([IP_OPTIONS, IP_RETOPTS]):
        rules.append(rule("setsockopt", "SCMP_ACT_ALLOW",
                          [masked(1, ALL64, IPPROTO_IP), masked(2, mask, value)],
                          comment="021: IPPROTO_IP, other optname"))
    return rules


def socket_rules() -> list[dict]:
    """The base's socket semantics plus protocol 262 refused on the low 32
    bits. Domain is compared exactly (64 bits), as in the base."""
    rules = [rule("socket", "SCMP_ACT_ERRNO", [masked(2, LOW32, IPPROTO_MPTCP)], EPERM,
                  comment="021: IPPROTO_MPTCP (low 32 bits)")]
    rules.append(rule("socket", "SCMP_ACT_ERRNO",
                      [arg(0, "SCMP_CMP_EQ", AF_NETLINK), arg(2, "SCMP_CMP_EQ", NETLINK_AUDIT)], EINVAL,
                      excludes=_AUDIT, comment="base: NETLINK_AUDIT without CAP_AUDIT_WRITE"))

    def allow(domain_args: list[dict], protos, **kw):
        for mask, value in protos:
            rules.append(rule("socket", "SCMP_ACT_ALLOW", [*domain_args, masked(2, mask, value)],
                              comment="021: allowed socket", **kw))

    # With CAP_AUDIT_WRITE: any domain, any protocol but MPTCP.
    allow([], complement_cubes([IPPROTO_MPTCP]), includes=_AUDIT)
    # Without: any domain with a protocol other than 9 and 262; protocol 9
    # with any domain but AF_NETLINK.
    allow([], complement_cubes([IPPROTO_MPTCP, NETLINK_AUDIT]), excludes=_AUDIT)
    nine = [(ALL64, NETLINK_AUDIT)]
    allow([arg(0, "SCMP_CMP_LT", AF_NETLINK)], nine, excludes=_AUDIT)
    allow([arg(0, "SCMP_CMP_GT", AF_NETLINK)], nine, excludes=_AUDIT)
    return rules


def socketcall_rules() -> list[dict]:
    return [rule("socketcall", "SCMP_ACT_ERRNO", [], EPERM,
                 comment="021: 32-bit socketcall, whose arguments seccomp can't inspect")]


def native_only(arch_map: list[dict]) -> list[dict]:
    return [dict(entry, subArchitectures=[]) for entry in arch_map]


def derive(base: dict) -> dict:
    check_base(base)
    profile = copy.deepcopy(base)
    profile["archMap"] = native_only(profile["archMap"])
    if profile.get("architectures"):
        raise BaseMismatch("explicit architectures")
    kept = []
    for entry in profile["syscalls"]:
        names = [n for n in entry["names"] if n not in CHANGED]
        if not names:
            continue  # the base's socket rules: replaced below
        entry["names"] = names
        kept.append(entry)
    profile["syscalls"] = kept + socketcall_rules() + setsockopt_rules() + socket_rules()
    if any(entry.get("subArchitectures") for entry in profile["archMap"]):
        raise BaseMismatch("sub-architectures enabled")
    return profile


def bytes_module(text: bytes) -> str:
    """The TypeScript module that carries the profile's exact bytes. They are
    embedded as base64 because parsing the JSON in JavaScript would round
    every value above 2^53."""
    return (
        "// Generated by generate.py: the exact bytes of cocalc-project-seccomp.json.\n"
        "// Do not edit; regenerate.\n"
        "export const PROFILE_SHA256 =\n"
        f'  "{hashlib.sha256(text).hexdigest()}";\n'
        "export const PROFILE_BASE64 =\n"
        f'  "{base64.b64encode(text).decode()}";\n'
    )


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: generate.py <base-seccomp.json> <output.json> <output-bytes.ts>",
              file=sys.stderr)
        return 2
    with open(argv[1], "rb") as f:
        raw = f.read()
    try:
        profile = derive(json.loads(raw))
    except BaseMismatch as err:
        print(f"base profile differs from the reviewed one ({err}): review generate.py", file=sys.stderr)
        return 1
    profile["comment"] = (
        "Generated by generate.py from the hosts' base profile "
        f"(sha256 {hashlib.sha256(raw).hexdigest()}). Do not edit."
    )
    text = (json.dumps(profile, indent=1) + "\n").encode()
    with open(argv[2], "wb") as f:
        f.write(text)
    with open(argv[3], "w", encoding="utf-8") as f:
        f.write(bytes_module(text))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
