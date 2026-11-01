#!/usr/bin/python3
"""Tests for generate.py: python3 -I generate.test.py

The kernel-level check (libseccomp loading, real syscalls, and a
differential against the base) is kernel_check.py; it needs a Linux host
and is run by hand."""

import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("generate", HERE / "generate.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

BASE = json.loads((HERE / "base-seccomp.json").read_text())
PROFILE = json.loads((HERE / "cocalc-project-seccomp.json").read_text())
LOW32 = 0xFFFFFFFF
MASK64 = (1 << 64) - 1


def matches(arg: dict, value: int) -> bool:
    op, a, b = arg["op"], arg["value"], arg.get("valueTwo", 0)
    if op == "SCMP_CMP_EQ":
        return value == a
    if op == "SCMP_CMP_NE":
        return value != a
    if op == "SCMP_CMP_LT":
        return value < a
    if op == "SCMP_CMP_GT":
        return value > a
    if op == "SCMP_CMP_MASKED_EQ":
        return value & a == b
    raise AssertionError(op)


def applies(rule: dict, caps: set[str]) -> bool:
    inc, exc = rule.get("includes") or {}, rule.get("excludes") or {}
    if inc.get("caps") and not set(inc["caps"]) <= caps:
        return False
    return not (exc.get("caps") and set(exc["caps"]) & caps)


def actions(profile: dict, name: str, args: dict[int, int], caps: set[str]) -> set:
    """The (action, errno) of every rule for name that matches args."""
    out = set()
    for rule in profile["syscalls"]:
        if name not in rule["names"] or not applies(rule, caps):
            continue
        if all(matches(a, args[a["index"]]) for a in rule.get("args") or []):
            out.add((rule["action"], rule.get("errnoRet")))
    return out


def values(points: list[int]) -> list[int]:
    """Each point and its neighbours, with the high word 0, 1 and all ones."""
    lows = set()
    for p in points + [0, 255, 256, 65534, 65535, 65536, 65537, LOW32]:
        lows.update(v & LOW32 for v in (p - 1, p, p + 1))
    return sorted({(hi << 32) | lo for lo in lows for hi in (0, 1, LOW32)})


SOCKET_GRID = [(d, p) for d in values([1, 2, 10, 16, 17, 40]) for p in values([0, 6, 9, 17, 262])]
SETSOCKOPT_GRID = [(lv, op) for lv in values([0, 1, 6, 41]) for op in values([1, 4, 7, 26])]


class GeneratorTest(unittest.TestCase):
    def test_checked_in_profile_is_the_generator_output(self):
        regenerated = gen.derive(BASE)
        expected = copy.deepcopy(PROFILE)
        del expected["comment"]
        self.assertEqual(regenerated, expected)

    def test_base_fingerprint_is_enforced(self):
        gen.check_base(BASE)
        for mutate in (
            lambda b: next(r for r in b["syscalls"] if r["names"] == ["socket"])["args"][0].update(value=17),
            lambda b: b["syscalls"].append({"names": ["socket"], "action": "SCMP_ACT_ALLOW", "args": []}),
            lambda b: b["syscalls"].append({"names": ["setsockopt"], "action": "SCMP_ACT_ALLOW",
                                            "args": [{"index": 1, "op": "SCMP_CMP_EQ", "value": 0}]}),
            lambda b: b["syscalls"].append({"names": ["socketcall"], "action": "SCMP_ACT_ERRNO"}),
        ):
            base = copy.deepcopy(BASE)
            mutate(base)
            with self.assertRaises(gen.BaseMismatch):
                gen.check_base(base)

    def test_cubes_cover_exactly_the_complement(self):
        for points in ([0], [262], [4, 7], [9, 262]):
            covered = []
            for mask, value in gen.complement_cubes(points):
                size = (~mask & MASK64) + 1
                self.assertEqual(value & ~mask & MASK64, 0)  # aligned
                self.assertEqual(mask >> 32, LOW32)  # high word pinned to 0
                covered.extend(range(value, value + size))
            self.assertEqual(sorted(covered), [v for v in range(1 << 16) if v not in points])
            self.assertEqual(len(covered), len(set(covered)))  # disjoint

    def test_only_the_three_syscalls_changed(self):
        def other(profile):
            return [r for r in profile["syscalls"]
                    if not set(r["names"]) & {"socket", "setsockopt", "socketcall"}]

        stripped = []
        for rule in copy.deepcopy(BASE["syscalls"]):
            rule["names"] = [n for n in rule["names"] if n not in gen.CHANGED]
            if rule["names"]:
                stripped.append(rule)
        self.assertEqual(other(PROFILE)[:len(stripped)], stripped)
        self.assertEqual(len(other(PROFILE)), len(stripped))
        for key in ("defaultAction", "defaultErrnoRet", "archMap"):
            self.assertEqual(PROFILE[key], BASE[key])

    def test_no_io_uring_and_no_unconditional_socket_calls(self):
        for rule in PROFILE["syscalls"]:
            if rule["action"] == "SCMP_ACT_ALLOW":
                self.assertFalse([n for n in rule["names"] if n.startswith("io_uring")])
                if set(rule["names"]) & set(gen.CHANGED):
                    self.assertTrue(rule.get("args"))


class DecisionTest(unittest.TestCase):
    """Rules with different actions never overlap, and each argument tuple
    gets the intended decision, including high-word truncation cases."""

    def test_socket(self):
        for caps in (set(), {"CAP_AUDIT_WRITE"}):
            for d, p in SOCKET_GRID:
                got = actions(PROFILE, "socket", {0: d, 1: 1, 2: p}, caps)
                self.assertLessEqual(len(got), 1, (caps, hex(d), hex(p), got))
                if p & LOW32 == 262:
                    want = {("SCMP_ACT_ERRNO", 1)}
                elif not caps and d == 16 and p == 9:
                    want = {("SCMP_ACT_ERRNO", 22)}
                elif p >> 32 or p >= 1 << 16:
                    want = set()  # default action
                else:
                    want = {("SCMP_ACT_ALLOW", None)}
                self.assertEqual(got, want, (caps, hex(d), hex(p)))

    def test_setsockopt(self):
        for lv, op in SETSOCKOPT_GRID:
            got = actions(PROFILE, "setsockopt", {0: 3, 1: lv, 2: op}, set())
            self.assertLessEqual(len(got), 1, (hex(lv), hex(op), got))
            if lv & LOW32 == 0 and op & LOW32 in (4, 7):
                want = {("SCMP_ACT_ERRNO", 1)}
            elif lv >> 32 or lv >= 1 << 16 or (lv == 0 and (op >> 32 or op >= 1 << 16)):
                want = set()
            else:
                want = {("SCMP_ACT_ALLOW", None)}
            self.assertEqual(got, want, (hex(lv), hex(op)))

    def test_truncation_cases(self):
        self.assertEqual(actions(PROFILE, "socket", {0: 2, 1: 1, 2: 0x1_00000106}, set()),
                         {("SCMP_ACT_ERRNO", 1)})
        for opt in (0x1_00000004, 0x1_00000007):
            self.assertEqual(actions(PROFILE, "setsockopt", {0: 3, 1: 0, 2: opt}, set()),
                             {("SCMP_ACT_ERRNO", 1)})
        self.assertEqual(actions(PROFILE, "setsockopt", {0: 3, 1: 0x1_00000000, 2: 4}, set()),
                         {("SCMP_ACT_ERRNO", 1)})
        self.assertEqual(actions(PROFILE, "socketcall", {}, set()), {("SCMP_ACT_ERRNO", 1)})


if __name__ == "__main__":
    unittest.main()
