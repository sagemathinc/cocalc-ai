#!/usr/bin/env python3
"""Scrubs the project-data btrfs filesystem once a period, a little at a time.

Run hourly by a systemd timer, as root. Each run decides from the saved
status whether a scrub is due (once a period after the last completed one; the
first one at a point in the period derived from the machine id, so hosts don't
all scrub at once), and if so starts or resumes it while the host is quiet,
for at most a daily budget of time, at a throttled speed, and only at night
where the host is (00:00-06:00 by default, in the timezone of its cloud zone). btrfs keeps a
cancelled scrub's progress, so a scrub spans as many runs as it needs. The
status, with btrfs's error counters and the files with uncorrectable errors,
is written for the project host to report (its heartbeat reader is a
follow-up).

Scrubbing happens only where the root-owned config enables it
({"enabled": true}); it can also set period_days, grace_days, daily_hours and
speed (bytes/s). Elsewhere the status still says when one would be due."""

import argparse
import calendar
import datetime
import grp
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.request
import zoneinfo

GIB = 1 << 30
MIB = 1 << 20
# Commands by absolute path (the unit's PATH is minimal too): a root job must
# not pick up a planted binary from an earlier PATH entry.
BTRFS = "/usr/bin/btrfs"
FINDMNT = "/usr/bin/findmnt"
JOURNALCTL = "/usr/bin/journalctl"
# Night where the host physically is: the timezone of its GCP region.
GCP_REGION_TIMEZONES = {
    "us-west1": "America/Los_Angeles",
    "us-west2": "America/Los_Angeles",
    "us-west3": "America/Denver",
    "us-west4": "America/Los_Angeles",
    "us-central1": "America/Chicago",
    "us-south1": "America/Chicago",
    "us-east1": "America/New_York",
    "us-east4": "America/New_York",
    "us-east5": "America/New_York",
    "northamerica-northeast1": "America/Toronto",
    "northamerica-northeast2": "America/Toronto",
    "northamerica-south1": "America/Mexico_City",
    "southamerica-east1": "America/Sao_Paulo",
    "southamerica-west1": "America/Santiago",
    "europe-west1": "Europe/Brussels",
    "europe-west2": "Europe/London",
    "europe-west3": "Europe/Berlin",
    "europe-west4": "Europe/Amsterdam",
    "europe-west6": "Europe/Zurich",
    "europe-west8": "Europe/Rome",
    "europe-west9": "Europe/Paris",
    "europe-west10": "Europe/Berlin",
    "europe-west12": "Europe/Rome",
    "europe-north1": "Europe/Helsinki",
    "europe-north2": "Europe/Stockholm",
    "europe-central2": "Europe/Warsaw",
    "europe-southwest1": "Europe/Madrid",
    "asia-east1": "Asia/Taipei",
    "asia-east2": "Asia/Hong_Kong",
    "asia-northeast1": "Asia/Tokyo",
    "asia-northeast2": "Asia/Tokyo",
    "asia-northeast3": "Asia/Seoul",
    "asia-south1": "Asia/Kolkata",
    "asia-south2": "Asia/Kolkata",
    "asia-southeast1": "Asia/Singapore",
    "asia-southeast2": "Asia/Jakarta",
    "australia-southeast1": "Australia/Sydney",
    "australia-southeast2": "Australia/Melbourne",
    "me-west1": "Asia/Jerusalem",
    "me-central1": "Asia/Qatar",
    "me-central2": "Asia/Riyadh",
    "africa-south1": "Africa/Johannesburg",
}
# A region not listed above: its continent at least.
GCP_PREFIX_TIMEZONES = (
    ("us-", "America/Chicago"),
    ("northamerica-", "America/Toronto"),
    ("southamerica-", "America/Sao_Paulo"),
    ("europe-", "Europe/Berlin"),
    ("asia-", "Asia/Singapore"),
    ("australia-", "Australia/Sydney"),
    ("me-", "Asia/Dubai"),
    ("africa-", "Africa/Johannesburg"),
)
GCP_ZONE_URL = "http://metadata.google.internal/computeMetadata/v1/instance/zone"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_PATH_CHARS = 512
# How long to keep retrying a cancel that fails before leaving the scrub,
# still throttled, to the next run.
CANCEL_GIVE_UP_S = 600
DAY = 86400
STATUS_VERSION = 1
MAX_PATHS = 100
# The default throttle: this share of a disk's read bandwidth (the GCP
# pd-balanced formula bootstrap also uses for I/O limits), or a fixed speed.
SHARE = 0.2
DEFAULT_SPEED = 50 * MIB
COUNTERS = (
    "read_errors",
    "csum_errors",
    "verify_errors",
    "super_errors",
    "malloc_errors",
    "uncorrectable_errors",
    "unverified_errors",
    "corrected_errors",
    "data_bytes_scrubbed",
    "tree_bytes_scrubbed",
)
PATH_RE = re.compile(r"\(path: (.*)\)\s*$")


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def parse_iso(text):
    try:
        return float(calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ")))
    except (TypeError, ValueError):
        return None


class Host:
    """Everything that touches the system, replaceable in tests."""

    def __init__(self, sysfs="/sys", proc="/proc", machine_id="/etc/machine-id"):
        self.sysfs = sysfs
        self.proc = proc
        self.machine_id_path = machine_id

    def now(self):
        return time.time()

    def sleep(self, seconds):
        time.sleep(seconds)

    def run(self, args):
        p = subprocess.run(args, capture_output=True, text=True, timeout=120)
        return p.returncode, p.stdout, p.stderr

    def read(self, path):
        with open(path, encoding="utf-8") as f:
            return f.read()

    def write(self, path, text):
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def read_trusted(self, path):
        """A config file's text, if it is a regular file root owns and only
        root can write; otherwise None."""
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            return None
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
                return None
            with os.fdopen(os.dup(fd), encoding="utf-8") as f:
                return f.read(1 << 20)
        finally:
            os.close(fd)

    def listdir(self, path):
        try:
            return sorted(os.listdir(path))
        except OSError:
            return []

    def cloud_zone(self):
        """The GCP zone this VM runs in (e.g. us-west2-a), or None."""
        req = urllib.request.Request(GCP_ZONE_URL, headers={"Metadata-Flavor": "Google"})
        try:
            with urllib.request.urlopen(req, timeout=2) as resp:
                return resp.read(256).decode().rsplit("/", 1)[-1].strip() or None
        except (OSError, ValueError):
            return None

    def system_timezone(self):
        try:
            return self.read("/etc/timezone").strip() or None
        except OSError:
            return None

    def machine_id(self):
        try:
            return self.read(self.machine_id_path).strip()
        except OSError:
            return ""


def filesystem(host, mount):
    """(fsid, devices) of the btrfs filesystem at mount, or None."""
    code, out, _ = host.run([FINDMNT, "-n", "-o", "FSTYPE,UUID", "--target", mount])
    parts = out.split()
    if code != 0 or len(parts) != 2 or parts[0] != "btrfs" or not UUID_RE.match(parts[1]):
        return None
    fsid = parts[1]
    base = os.path.join(host.sysfs, "fs", "btrfs", fsid)
    devids = host.listdir(os.path.join(base, "devinfo"))
    names = host.listdir(os.path.join(base, "devices"))
    if not devids:
        return None
    return fsid, {"devids": devids, "names": names}


def device_bytes(host, name):
    try:
        return int(host.read(os.path.join(host.sysfs, "class", "block", name, "size"))) * 512
    except (OSError, ValueError):
        return 0


def balanced_read_bps(size_bytes):
    # bootstrap.py balanced_device_capacity(): physical_read_bps
    return min(240 * MIB, 140 * MIB + (28 * size_bytes * MIB) // (100 * GIB))


def default_speed(host, capacity_path, devices):
    """Bytes/s for scrub_speed_max: a share of the disk's read bandwidth on
    GCP pd-balanced disks, otherwise a fixed speed."""
    try:
        capacity = json.loads(host.read_trusted(capacity_path) or "{}")
    except ValueError:
        capacity = {}
    targets = capacity.get("targets") if isinstance(capacity, dict) else None
    balanced = (
        isinstance(capacity, dict)
        and capacity.get("provider") == "gcp"
        and isinstance(targets, list)
        and bool(targets)
        and all(isinstance(t, dict) and t.get("disk_type") == "balanced" for t in targets)
    )
    sizes = [device_bytes(host, name) for name in devices["names"]]
    if balanced and sizes and all(sizes):
        return max(MIB, int(min(balanced_read_bps(s) for s in sizes) * SHARE))
    return DEFAULT_SPEED


def valid_timezone(name):
    try:
        return zoneinfo.ZoneInfo(name) if isinstance(name, str) and name else None
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        return None


def zone_timezone(zone):
    region = zone.rsplit("-", 1)[0] if zone and zone.count("-") >= 2 else zone
    if region in GCP_REGION_TIMEZONES:
        return GCP_REGION_TIMEZONES[region]
    for prefix, tz in GCP_PREFIX_TIMEZONES:
        if region and region.startswith(prefix):
            return tz
    return None


def host_timezone(host, override):
    """(tzinfo, name, source, warning) for when night is, where the host is."""
    tz = valid_timezone(override)
    if tz:
        return tz, override, "config", None
    zone = host.cloud_zone()
    name = zone_timezone(zone) if zone else None
    if valid_timezone(name):
        return valid_timezone(name), name, "zone %s" % zone, None
    name = host.system_timezone()
    if name not in (None, "Etc/UTC", "UTC") and valid_timezone(name):
        return valid_timezone(name), name, "system", None
    return datetime.timezone.utc, "UTC", "fallback", "host location unknown: night is UTC"


def night_window(now, tz, start_hour, hours):
    """(start, end) timestamps of the night window containing now, or of the
    next one if now is outside any."""
    local = datetime.datetime.fromtimestamp(now, tz)
    for days in (-1, 0, 1):
        day = (local + datetime.timedelta(days=days)).date()
        start_local = datetime.datetime(day.year, day.month, day.day, start_hour, tzinfo=tz)
        # wall-clock hours: the window keeps its local times across DST
        start = start_local.timestamp()
        end = (start_local + datetime.timedelta(hours=hours)).timestamp()
        if now < end:
            return start, end
    return start, end


def pressure(host):
    """The io 'full' share over the last minute, in percent (100 if unknown)."""
    try:
        for line in host.read(os.path.join(host.proc, "pressure", "io")).splitlines():
            if line.startswith("full "):
                for field in line.split():
                    if field.startswith("avg60="):
                        return float(field[len("avg60="):])
    except (OSError, ValueError):
        pass
    return 100.0


def scrub_status(host, mount):
    """btrfs scrub status -R as a dict: 'status' (finished, running,
    interrupted, aborted, none, or unknown when it can't be read) and the raw
    counters."""
    try:
        code, out, _ = host.run([BTRFS, "scrub", "status", "-R", mount])
    except Exception:
        code, out = 1, ""
    result = {"status": "unknown"}
    seen = set()
    if code != 0:
        return result
    result["status"] = "none"
    for line in out.splitlines():
        key, sep, value = line.strip().partition(":")
        if not sep:
            continue
        key = key.strip().lower().replace(" ", "_")
        value = value.strip()
        seen.add(key)
        if key == "status":
            result["status"] = value.split()[0].lower() if value else "none"
        elif key in COUNTERS:
            try:
                result[key] = int(value.split()[0])
            except (IndexError, ValueError):
                pass
    if "no stats available" in out:
        result["status"] = "none"
    elif "status" not in seen:
        # older btrfs-progs: the state is only in the plain output
        _, plain, _ = host.run([BTRFS, "scrub", "status", mount])
        for line in plain.splitlines():
            key, sep, value = line.strip().partition(":")
            if sep and key.strip().lower() == "status" and value.strip():
                result["status"] = value.split()[0].lower()
    return result


def error_paths(host, since):
    """Files the kernel named while scrubbing, for errors it couldn't fix."""
    # kernel messages from every boot (-k means this boot only): a scrub
    # resumed after a reboot counts errors found before it
    code, out, _ = host.run(
        [JOURNALCTL, "_TRANSPORT=kernel", "--no-pager", "-o", "cat", "--since", "@%d" % int(since)]
    )
    if code != 0:
        return [], False
    paths = []
    for line in out.splitlines():
        if "BTRFS" not in line or "error" not in line:
            continue
        m = PATH_RE.search(line)
        # user-controlled names: bounded, and shown only as text
        path = m.group(1)[:MAX_PATH_CHARS] if m else None
        if path and path not in paths:
            paths.append(path)
    return paths[:MAX_PATHS], len(paths) > MAX_PATHS


def cancel(host, mount):
    """Cancels the scrub; True once its status confirms it no longer runs."""
    try:
        host.run([BTRFS, "scrub", "cancel", mount])
    except Exception:
        pass
    for _ in range(5):
        # confirmed only by a status read that worked
        if scrub_status(host, mount)["status"] not in ("running", "unknown"):
            return True
        host.sleep(1)
    return False


def knob_paths(host, fsid, devices):
    return {
        os.path.join(host.sysfs, "fs", "btrfs", fsid, "devinfo", devid, "scrub_speed_max")
        for devid in devices["devids"]
    }


KNOB_VALUE_RE = re.compile(r"^[0-9]{1,20}$")


def kept_values(kept, knobs):
    """The saved throttle values to restore: only this filesystem's knobs, and
    only numbers (the status file must not be a way to write elsewhere)."""
    if not isinstance(kept, dict):
        return {}
    return {
        k: v
        for k, v in kept.items()
        if k in knobs and isinstance(v, str) and KNOB_VALUE_RE.match(v)
    }


def read_speeds(host, knobs):
    """The knobs' current values (decimal strings), without changing them."""
    values = {}
    for path in sorted(knobs):
        try:
            value = host.read(path).strip()
        except OSError:
            continue
        if KNOB_VALUE_RE.match(value):
            values[path] = value
    return values


def set_speed(host, knobs, speed):
    """Sets scrub_speed_max on each knob (whose old values are saved first);
    True only if every one of them reads back the cap."""
    capped = True
    for path in sorted(knobs):
        try:
            host.write(path, "%d" % speed)
            capped = capped and host.read(path).strip() == "%d" % speed
        except OSError:
            capped = False
    return capped


def restore_speed(host, previous):
    """Puts the saved values back; returns those it couldn't write."""
    failed = {}
    for path, value in previous.items():
        try:
            host.write(path, value or "0")
        except OSError:
            failed[path] = value
    return failed


class StatusDir:
    """The status directory and file: owned by root, readable by the project
    host's group only (the status names customer files), never through a
    symlink."""

    NAME = "status.json"

    def __init__(self, path, gid):
        self.gid = gid
        try:
            os.mkdir(path, 0o750)
        except FileExistsError:
            pass
        self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        os.fchown(self.fd, os.geteuid(), gid)
        os.fchmod(self.fd, 0o750)

    def load(self):
        try:
            fd = os.open(self.NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
        except OSError:
            return {}
        try:
            with os.fdopen(fd, encoding="utf-8") as f:
                data = json.load(f)
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def save(self, status):
        tmp = "%s.%d.tmp" % (self.NAME, os.getpid())
        try:
            os.unlink(tmp, dir_fd=self.fd)
        except FileNotFoundError:
            pass
        fd = os.open(
            tmp,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o640,
            dir_fd=self.fd,
        )
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            os.fchown(f.fileno(), os.geteuid(), self.gid)
            os.fchmod(f.fileno(), 0o640)
            json.dump(status, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, self.NAME, src_dir_fd=self.fd, dst_dir_fd=self.fd)


def due_at(status, host, period_s, now, next_due=None):
    """When the next scrub is due: a period after the last completed one; the
    first one, at a point in the first period from the machine's id. A
    configured next_due brings it forward once: it counts only until a scrub
    completes after it."""
    last = (status.get("last_completed") or {}).get("finished_at")
    last_ts = parse_iso(last) if last else None
    if last_ts is not None:
        due = last_ts + period_s
    else:
        first_seen = parse_iso(status.get("first_seen_at")) or now
        digest = hashlib.sha256(host.machine_id().encode()).digest()
        offset = int.from_bytes(digest[:8], "big") % max(1, int(period_s))
        due = first_seen + offset
    if next_due is not None and (last_ts is None or last_ts < next_due):
        due = min(due, next_due)
    return due


# Settings the config may set, within bounds, so even a wrong config can't
# make the scrub hog the disk.
CONFIG_KEYS = {
    "period_days": (float, 1, 365),
    "grace_days": (float, 0, 60),
    "daily_hours": (float, 0.25, 24),
    "speed": (int, MIB, 512 * MIB),
    "night_start_hour": (int, 0, 23),
    "night_hours": (float, 1, 24),
}


def apply_config(args, host):
    """True if scrubbing is enabled; settings in the config override args. A
    config that isn't root's alone counts as absent."""
    try:
        config = json.loads(host.read_trusted(args.config) or "null")
    except ValueError:
        return False
    if not isinstance(config, dict):
        return False
    for key, (kind, low, high) in CONFIG_KEYS.items():
        value = config.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and low <= value <= high:
            setattr(args, key, kind(value))
    if isinstance(config.get("timezone"), str):
        args.timezone = config["timezone"]
    # one scrub due at this time (a pilot, say), unless one completed since
    next_due = parse_iso(config.get("next_due")) if isinstance(config.get("next_due"), str) else None
    if next_due is not None:
        args.next_due = next_due
    return config.get("enabled") is True


def run(args, host, store):
    enabled = apply_config(args, host)
    status = store.load()
    now = host.now()
    status.setdefault("version", STATUS_VERSION)
    status.setdefault("first_seen_at", iso(now))
    status["mount"] = args.mount
    period_s = args.period_days * DAY
    fs = filesystem(host, args.mount)
    if fs is None:
        status.update(state="unsupported", reason="not a btrfs filesystem", updated_at=iso(now))
        store.save(status)
        return 0
    fsid, devices = fs
    if status.get("fsid") not in (None, fsid):
        # a new filesystem at the mount: what was scrubbed is gone
        for key in ("last_completed", "current", "overdue_since", "runtime_day", "runtime_today_s"):
            status.pop(key, None)
        status["first_seen_at"] = iso(now)
    status["fsid"] = fsid
    due = due_at(status, host, period_s, now, args.next_due)
    status["due_at"] = iso(due)
    current = status.get("current")
    tz, tz_name, tz_source, tz_warning = host_timezone(host, args.timezone)
    window_start, window_end = night_window(now, tz, args.night_start_hour, args.night_hours)
    # The daily budget is per night (one per local day), not per UTC day: a
    # night that crosses 00:00 UTC is still one budget.
    day = iso(window_start)
    if status.get("runtime_day") != day:
        status["runtime_day"], status["runtime_today_s"] = day, 0
    budget_s = args.daily_hours * 3600 - status.get("runtime_today_s", 0)
    status["night"] = {
        "timezone": tz_name,
        "source": tz_source,
        "start": iso(window_start),
        "end": iso(window_end),
    }
    if tz_warning:
        status["night"]["warning"] = tz_warning
    in_night = window_start <= now < window_end
    st = scrub_status(host, args.mount)
    if st["status"] == "unknown":
        return_unknown = True
    else:
        return_unknown = False
    # Ours only if a run was watching it (phase "running") and died without
    # confirming a cancel (SIGKILL, a crash). After a confirmed cancel
    # (phase "interrupted"), a running scrub was started by someone else.
    orphan = (
        current is not None
        and current.get("phase") == "running"
        and st["status"] == "running"
    )

    knobs = knob_paths(host, fsid, devices)

    def restore_kept_throttle():
        # a throttle a run had to leave on, with the values it replaced
        failed = restore_speed(host, kept_values(status.pop("throttle_restore", None), knobs))
        if failed:
            status["throttle_restore"] = failed  # the next run tries again

    def stop_orphan():
        """False if our scrub runs on: it couldn't be cancelled."""
        if not orphan:
            return True
        if not cancel(host, args.mount):
            return False
        current["phase"] = "interrupted"
        restore_kept_throttle()
        return True

    def leave(state, reason):
        # a scrub this service won't watch now must not run on unwatched
        if not stop_orphan():
            return finish("error", "the scrub could not be cancelled; throttle kept")
        return finish(state, reason)

    if return_unknown:
        status["state"], status["reason"] = "error", "btrfs scrub status unavailable"
        status["updated_at"] = iso(now)
        store.save(status)
        return 0
    if not orphan and "throttle_restore" in status:
        # no scrub of ours runs any more: put the kept throttle back now
        restore_kept_throttle()

    def settle(state, reason=None):
        status["state"] = state
        if reason:
            status["reason"] = reason
        else:
            status.pop("reason", None)
        if host.now() > due + args.grace_days * DAY and state != "idle":
            status.setdefault("overdue_since", iso(due + args.grace_days * DAY))
            # an error (a scrub that couldn't be cancelled, say) stays one
            if state == "paused":
                status["state"] = "overdue"
        status["updated_at"] = iso(host.now())

    def finish(state, reason=None):
        settle(state, reason)
        store.save(status)
        return 0

    def complete(st, started_at):
        errors = {k: st.get(k, 0) for k in COUNTERS}
        paths, truncated = [], False
        if errors["uncorrectable_errors"] or errors["csum_errors"] or errors["read_errors"]:
            paths, truncated = error_paths(host, parse_iso(started_at) or now)
        finished = host.now()
        status["last_completed"] = {
            "started_at": started_at,
            "finished_at": iso(finished),
            "errors": errors,
            "error_paths": paths,
            "error_paths_truncated": truncated,
        }
        status["current"] = None
        status["due_at"] = iso(finished + period_s)
        status.pop("overdue_since", None)
        status["state"] = "idle"
        status.pop("reason", None)
        status["updated_at"] = iso(finished)
        store.save(status)
        return 0

    if current is not None and st["status"] == "finished":
        if current.get("launched", True):
            # finished after the last run stopped watching it
            return complete(st, current.get("started_at"))
        # saved just before a start or resume that never ran: the stats are
        # the previous scrub's, so this one is still to do
        status["current"] = current = None
    if not enabled:
        if not stop_orphan():
            return finish("error", "the scrub could not be cancelled; throttle kept")
        status["state"], status["reason"] = "disabled", "not enabled on this host"
        status["updated_at"] = iso(now)
        store.save(status)
        return 0
    if current is None and now < due:
        return finish("idle", "not due")
    if not in_night:
        return leave("paused", "outside the night window")
    if budget_s <= 0:
        return leave("paused", "daily time budget used")
    if pressure(host) > args.resume_below:
        return leave("paused", "host I/O pressure")

    if not orphan and st["status"] == "running":
        # someone else's scrub (an admin's, say): leave it alone
        return finish("paused", "a scrub not started by this service is running")

    speed = args.speed or default_speed(host, args.capacity, devices)
    status["speed_max_bytes"] = speed
    kept = kept_values(status.pop("throttle_restore", None), knobs)
    previous = read_speeds(host, knobs)
    if kept:
        # the knobs hold our own throttle (our scrub's, or one a restore
        # couldn't undo): restore what it replaced
        previous.update(kept)
    # Saved before any knob changes: whenever a run dies from here on (even
    # by SIGKILL), a later run puts these values back.
    status["throttle_restore"] = previous
    store.save(status)
    started = host.now()
    # Until the loop below sees the scrub end or cancels it, leaving any other
    # way (an exception, SIGTERM from systemd) cancels it: a scrub never runs
    # without this service watching its pressure and time budget.
    supervising = False
    try:
        if not (knobs and set(previous) == knobs and set_speed(host, knobs, speed)):
            # The cap is the scrub's only throttle: no scrub runs unless every
            # device has it (and its old value saved to restore).
            supervising = orphan  # one of ours that runs on is cancelled
            return finish("error", "the scrub speed could not be capped")
        if orphan:
            # watch it again, throttled
            current["launched"] = True
            supervising = True
        else:
            before = dict(current) if current is not None else None
            # recorded before the scrub runs, so a run killed from here on
            # leaves it adoptable
            current = dict(current or {"started_at": iso(started)})
            current["phase"] = "running"
            # until start or resume works, a "finished" status is the last
            # scrub's, not this one's
            current["launched"] = False
            status["current"] = current
            store.save(status)
            supervising = True
            resumed = False
            if before is not None:
                code, _, _ = host.run([BTRFS, "scrub", "resume", args.mount])
                resumed = code == 0
            if not resumed:
                current["started_at"] = iso(started)
                code, _, err = host.run([BTRFS, "scrub", "start", args.mount])
                if code != 0:
                    supervising = False
                    status["current"] = before
                    return finish("error", "btrfs scrub start failed: %s" % err.strip()[:300])
            current["launched"] = True
        status["current"] = current
        status["state"] = "running"
        store.save(status)
        reason = None
        failed_cancels = 0
        accounted = started
        while True:
            host.sleep(args.poll_seconds)
            st = scrub_status(host, args.mount)
            elapsed = host.now() - started
            # counted as it goes: a SIGTERM (or worse) doesn't reset the day
            status["runtime_today_s"] = status.get("runtime_today_s", 0) + int(host.now() - accounted)
            accounted = host.now()
            if st["status"] != "unknown":
                current["data_bytes_scrubbed"] = st.get("data_bytes_scrubbed", 0)
            store.save(status)
            if st["status"] == "finished":
                supervising = False
                break
            # "unknown": it may still run, so it is watched as running
            if st["status"] not in ("running", "unknown"):
                supervising = False
                current["phase"] = "interrupted"
                reason = "scrub stopped (%s)" % st["status"]
                break
            if pressure(host) > args.pause_above:
                reason = "host I/O pressure"
            elif elapsed >= budget_s:
                reason = "daily time budget used"
            elif host.now() >= window_end:
                reason = "outside the night window"
            else:
                continue
            if not cancel(host, args.mount):
                # still running: keep watching it (and its throttle) a while,
                # then leave it to the next run, throttled
                failed_cancels += 1
                reason = None
                if failed_cancels * args.poll_seconds >= CANCEL_GIVE_UP_S:
                    break
                continue
            supervising = False
            current["phase"] = "interrupted"
            break
        if supervising:
            return 0  # couldn't stop it: finally reports it and keeps the throttle
        if reason is not None:
            return finish("paused", reason)
        return complete(st, current.get("started_at"))
    finally:
        if supervising:
            if cancel(host, args.mount):
                supervising = False
                if status.get("current"):
                    status["current"]["phase"] = "interrupted"
                if status.get("state") == "running":
                    # stopped here: not left reported as running until the
                    # next run (an error set before stays one)
                    settle("paused", "the scrub was stopped as this run ended")
            else:
                # it runs on: leave its throttle (throttle_restore stays), and
                # the next run adopts it
                status["state"] = "error"
                status["reason"] = "the scrub could not be cancelled; throttle kept"
        if not supervising:
            failed = restore_speed(host, previous)
            if failed:
                status["throttle_restore"] = failed  # the next run tries again
            else:
                status.pop("throttle_restore", None)
        try:
            store.save(status)
        except OSError:
            pass


def main(argv=None, host=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mount", default="/mnt/cocalc")
    p.add_argument("--status-dir", default="/var/lib/cocalc-btrfs-scrub")
    p.add_argument("--status-group", default="", help="group that may read the status")
    p.add_argument("--capacity", default="/etc/cocalc/project-io-capacity.json")
    p.add_argument("--config", default="/etc/cocalc/btrfs-scrub.json")
    p.add_argument("--period-days", type=float, default=30)
    p.add_argument("--grace-days", type=float, default=7)
    p.add_argument("--daily-hours", type=float, default=6)
    p.add_argument("--speed", type=int, default=0, help="bytes/s (default: derived)")
    p.add_argument("--resume-below", type=float, default=2.0, help="io full avg60 %%")
    p.add_argument("--pause-above", type=float, default=5.0, help="io full avg60 %%")
    p.add_argument("--poll-seconds", type=float, default=60)
    p.add_argument("--timezone", default="", help="IANA name (default: from the cloud zone)")
    p.add_argument("--night-start-hour", type=int, default=0)
    p.add_argument("--night-hours", type=float, default=6)
    p.set_defaults(next_due=None)
    args = p.parse_args(argv)
    try:
        gid = grp.getgrnam(args.status_group).gr_gid if args.status_group else os.getegid()
    except KeyError:
        gid = os.getegid()
    # systemd stops a run with SIGTERM (stop, or the start timeout): exit
    # through finally, which cancels a scrub this run supervises.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    return run(args, host or Host(), StatusDir(args.status_dir, gid))


if __name__ == "__main__":
    sys.exit(main())
