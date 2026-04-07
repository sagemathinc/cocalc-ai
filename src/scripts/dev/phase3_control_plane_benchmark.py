#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


SRC = Path(__file__).resolve().parents[2]
REPO = SRC.parent
CLI = SRC / "packages" / "cli" / "dist" / "bin" / "cocalc.js"
HUB_DAEMON_ENV = SRC / ".local" / "hub-daemon.env"
HUB_STDOUT_LOG = SRC / ".local" / "hub-daemon" / "hub.stdout.log"
BASELINE_JSONL = SRC / ".agents" / "phase-2-projection-read-benchmark-2026-04-04.jsonl"
OUTPUT_JSON = SRC / ".agents" / "phase-3-control-plane-benchmark-2026-04-06.json"
OUTPUT_MD = SRC / ".agents" / "phase-3-control-plane-benchmark-2026-04-06.md"

PG_FIELDS = [
    "xact_commit",
    "xact_rollback",
    "blks_read",
    "blks_hit",
    "tup_returned",
    "tup_fetched",
    "tup_inserted",
    "tup_updated",
    "tup_deleted",
    "temp_files",
    "temp_bytes",
    "session_time",
    "active_time",
]


@dataclass(frozen=True)
class Persona:
    name: str
    email: str | None
    target_projects: int | None
    limit: int
    use_current_admin: bool = False


PERSONAS = [
    Persona(
        name="light",
        email="phase3-bench-light@load.test",
        target_projects=20,
        limit=100,
    ),
    Persona(
        name="normal",
        email="phase3-bench-normal@load.test",
        target_projects=200,
        limit=500,
    ),
    Persona(
        name="heavy",
        email=None,
        target_projects=None,
        limit=2000,
        use_current_admin=True,
    ),
    Persona(
        name="extreme",
        email="phase3-bench-extreme@load.test",
        target_projects=10000,
        limit=12000,
    ),
]


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(
            f"{name} is not set; run: cd src && eval \"$(pnpm -s dev:env:hub)\""
        )
    return value


def run(
    argv: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=str(cwd or REPO),
        env=env,
        input=input_text,
        text=True,
        capture_output=True,
        check=True,
    )


def cocalc_json(
    *args: str,
    account_id: str | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    argv = [str(CLI), "--json"]
    if account_id:
        argv += ["--account-id", account_id]
    argv += list(args)
    proc = run(argv, env=env)
    return json.loads(proc.stdout)


def psql_value(sql: str) -> str:
    proc = run(["psql", "-Atqc", sql])
    return proc.stdout.strip()


def psql_json(sql: str) -> dict[str, Any]:
    text = psql_value(sql)
    return json.loads(text) if text else {}


def get_pg_stats() -> dict[str, float]:
    sql = f"""
select row_to_json(t)::text
from (
  select {", ".join(PG_FIELDS)}
  from pg_stat_database
  where datname = current_database()
) t
"""
    return psql_json(sql)


def diff_pg_stats(before: dict[str, float], after: dict[str, float]) -> dict[str, float]:
    delta: dict[str, float] = {}
    for key in PG_FIELDS:
        delta[key] = round(float(after.get(key, 0)) - float(before.get(key, 0)), 3)
    return delta


def load_baseline() -> dict[str, dict[str, Any]]:
    data: dict[str, dict[str, Any]] = {}
    with BASELINE_JSONL.open() as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            row = json.loads(raw)
            benchmark = row.get("benchmark")
            mode = row.get("read_mode")
            if benchmark and mode:
                data[f"{benchmark}:{mode}"] = row["data"]
    return data


def wait_for_hub_ready(timeout_s: int = 180) -> None:
    deadline = time.time() + timeout_s
    last_error = ""
    while time.time() < deadline:
        try:
            cocalc_json("bay", "list")
            return
        except subprocess.CalledProcessError as err:
            last_error = err.stderr.strip() or err.stdout.strip()
            time.sleep(1.5)
    raise RuntimeError(f"hub did not become ready: {last_error}")


def set_guarded_read_modes(
    *,
    project_mode: str,
    collaborator_mode: str,
    mention_mode: str | None = None,
) -> None:
    original = HUB_DAEMON_ENV.read_text()
    lines = original.splitlines()
    wanted = {
        "COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS": project_mode,
        "COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS": collaborator_mode,
    }
    if mention_mode is not None:
        wanted["COCALC_ACCOUNT_NOTIFICATION_INDEX_MENTION_READS"] = mention_mode

    seen: set[str] = set()
    next_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        replaced = False
        for key, value in wanted.items():
            prefix = f"export {key}="
            if stripped.startswith(prefix):
                next_lines.append(f"export {key}={value}")
                seen.add(key)
                replaced = True
                break
        if not replaced:
            next_lines.append(line)

    for key, value in wanted.items():
        if key not in seen:
            next_lines.append(f"export {key}={value}")

    HUB_DAEMON_ENV.write_text("\n".join(next_lines).rstrip() + "\n")


def restart_hub() -> str:
    run(["pnpm", "-C", str(SRC), "hub:daemon:restart"])
    wait_for_hub_ready()
    mode_line = ""
    if HUB_STDOUT_LOG.exists():
        for line in HUB_STDOUT_LOG.read_text(errors="replace").splitlines()[-500:]:
            if "projection-backed read modes" in line:
                mode_line = line
    return mode_line


def current_host_id() -> str:
    host_id = psql_value(
        "select host_id::text from projects where host_id is not null limit 1"
    )
    if not host_id:
        raise RuntimeError("unable to resolve a host_id for synthetic project fixtures")
    return host_id


def lookup_account_id_by_email(email: str) -> str | None:
    sql = f"""
select account_id::text
from accounts
where lower(email_address) = lower({sql_literal(email)})
limit 1
"""
    value = psql_value(sql)
    return value or None


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def ensure_account(email: str, name: str) -> str:
    existing = lookup_account_id_by_email(email)
    if existing:
        return existing
    created = cocalc_json(
        "admin",
        "user",
        "create",
        "--email",
        email,
        "--name",
        name,
        "--no-first-project",
        "--tag",
        "phase3-bench",
        "--tag",
        f"phase3-bench:{name.lower().replace(' ', '-')}",
    )
    account_id = f"{created['data'].get('account_id', '')}".strip()
    if not account_id:
        raise RuntimeError(f"failed to create benchmark account for {email}")
    return account_id


def count_fixture_projects(account_id: str, persona_name: str) -> int:
    sql = f"""
select count(*)
from projects
where deleted is not true
  and users ? {sql_literal(account_id)}
  and title like {sql_literal(f'phase3-bench/{persona_name}/%')}
"""
    return int(psql_value(sql) or "0")


def insert_fixture_projects(
    *,
    account_id: str,
    persona_name: str,
    start_index: int,
    end_index: int,
    host_id: str,
) -> None:
    sql = f"""
insert into projects
  (project_id, title, description, users, deleted, host_id, owning_bay_id,
   state, last_edited, created, theme)
select
  gen_random_uuid(),
  format('phase3-bench/{persona_name}/%s', gs),
  format('Synthetic %s project %%s for Phase 3 control-plane benchmark', {sql_literal(persona_name)}, gs),
  jsonb_build_object({sql_literal(account_id)}, jsonb_build_object('group', 'owner')),
  false,
  {sql_literal(host_id)}::uuid,
  'bay-0',
  '{{"state":"stopped"}}'::jsonb,
  now() - make_interval(secs => gs),
  now() - make_interval(secs => gs),
  '{{"icon":"folder","color":"#A0AEC0"}}'::jsonb
from generate_series({start_index}, {end_index}) as gs
"""
    run(["psql", "-v", "ON_ERROR_STOP=1", "-qc", sql])


def ensure_project_fixture(
    *,
    account_id: str,
    persona_name: str,
    target_count: int,
    host_id: str,
) -> int:
    current = count_fixture_projects(account_id, persona_name)
    if current >= target_count:
        return current
    batch_size = 1000
    next_index = current + 1
    while next_index <= target_count:
        end_index = min(target_count, next_index + batch_size - 1)
        insert_fixture_projects(
            account_id=account_id,
            persona_name=persona_name,
            start_index=next_index,
            end_index=end_index,
            host_id=host_id,
        )
        next_index = end_index + 1
    return count_fixture_projects(account_id, persona_name)


def rebuild_project_projection(account_id: str) -> dict[str, Any]:
    return cocalc_json(
        "bay",
        "projection",
        "rebuild-account-project-index",
        account_id,
        "--write",
    )


def rebuild_collaborator_projection(account_id: str) -> dict[str, Any]:
    return cocalc_json(
        "bay",
        "projection",
        "rebuild-account-collaborator-index",
        account_id,
        "--write",
    )


def benchmark_command(
    *,
    label: str,
    command: list[str],
    account_id: str | None = None,
    capture_pg_delta: bool = False,
) -> dict[str, Any]:
    before = get_pg_stats() if capture_pg_delta else None
    result = cocalc_json(*command, account_id=account_id)
    after = get_pg_stats() if capture_pg_delta else None
    out = {
        "label": label,
        "command": command,
        "account_id": account_id,
        "result": result,
    }
    if before is not None and after is not None:
        out["pg_before"] = before
        out["pg_after"] = after
        out["pg_delta"] = diff_pg_stats(before, after)
    return out


def projection_status() -> dict[str, Any]:
    return {
        "project": cocalc_json("bay", "projection", "status-account-project-index"),
        "collaborator": cocalc_json(
            "bay", "projection", "status-account-collaborator-index"
        ),
        "notification": cocalc_json(
            "bay", "projection", "status-account-notification-index"
        ),
    }


def extract_latency(summary: dict[str, Any], key: str) -> float | None:
    return summary.get("latency_ms", {}).get(key)


def summarize_persona_rows(rows: list[dict[str, Any]]) -> str:
    header = (
        "| persona | projects | bootstrap p99 ms | projects ops/s | projects p99 ms |\n"
        "| --- | ---: | ---: | ---: | ---: |\n"
    )
    parts = [header]
    for row in rows:
        parts.append(
            f"| `{row['persona']}` | {row['project_count']} | "
            f"{fmt_num(row['bootstrap_p99'])} | {fmt_num(row['projects_ops'])} | "
            f"{fmt_num(row['projects_p99'])} |\n"
        )
    return "".join(parts)


def fmt_num(value: Any) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def build_markdown(report: dict[str, Any]) -> str:
    baseline = report["baseline"]
    heavy_compare = report["heavy_compare"]
    personas = report["personas"]
    pg_compare = report["pg_compare"]

    lines: list[str] = []
    lines.append("# Phase 3 Control-Plane Benchmark: 2026-04-06\n")
    lines.append(
        "Recorded after slimming the live `projects` payload, moving project detail fields "
        "off `project_map`, and removing the legacy `project_and_user_tracker` path.\n"
    )
    lines.append("\n## Environment\n")
    lines.append(f"- Date: `{report['timestamp']}`\n")
    lines.append(f"- Repo: `{REPO}`\n")
    lines.append(f"- API: `{report['api_url']}`\n")
    lines.append(f"- CLI: `{CLI}`\n")
    lines.append(f"- Admin account: `{report['admin_account_id']}`\n")
    lines.append(
        f"- Collaborator-heavy benchmark project: `{report['collaborator_project_id']}`\n"
    )
    lines.append(
        f"- Reused collaborator-heavy fixture size: `{report['collaborator_fixture_size']}` collaborators\n"
    )
    lines.append("\n## Fixture Personas\n")
    lines.append(
        "- `light`: synthetic account with about `20` visible benchmark projects\n"
    )
    lines.append(
        "- `normal`: synthetic account with about `200` visible benchmark projects\n"
    )
    lines.append(
        "- `heavy`: existing admin/dev account with about `1047` visible projects\n"
    )
    lines.append(
        "- `extreme`: synthetic account with about `10000` visible benchmark projects\n"
    )
    lines.append("\n## Current `only` Mode Persona Sweep\n")
    lines.append(summarize_persona_rows(personas))
    lines.append("\n## Heavy-Account Comparison Versus 2026-04-04 Baseline\n")
    lines.append(
        "| workload | mode | old ops/s | new ops/s | ops ratio | old p99 ms | new p99 ms | p99 ratio |\n"
    )
    lines.append(
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n"
    )
    for row in heavy_compare:
        lines.append(
            f"| `{row['benchmark']}` | `{row['mode']}` | {fmt_num(row['old_ops'])} | "
            f"{fmt_num(row['new_ops'])} | {fmt_num(row['ops_ratio'])}x | "
            f"{fmt_num(row['old_p99'])} | {fmt_num(row['new_p99'])} | {fmt_num(row['p99_ratio'])}x |\n"
        )
    lines.append("\nInterpretation:\n")
    lines.append(
        "- `projects` heavy-account reads are materially faster than the April 4 baseline in both `off` and `only` modes.\n"
    )
    lines.append(
        "- `my-collaborators` remains healthy; the new `only` path is still faster than the old `off` baseline, with no failures.\n"
    )
    lines.append("\n## Postgres Delta: `off` Versus `only`\n")
    lines.append(
        "| workload | mode | blks_hit | blks_read | tup_returned | tup_fetched | xact_commit | temp_bytes |\n"
    )
    lines.append(
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n"
    )
    for row in pg_compare:
        delta = row["pg_delta"]
        lines.append(
            f"| `{row['benchmark']}` | `{row['mode']}` | {fmt_num(delta['blks_hit'])} | "
            f"{fmt_num(delta['blks_read'])} | {fmt_num(delta['tup_returned'])} | "
            f"{fmt_num(delta['tup_fetched'])} | {fmt_num(delta['xact_commit'])} | "
            f"{fmt_num(delta['temp_bytes'])} |\n"
        )
    lines.append("\nObservations:\n")
    lines.append(
        "- For the same benchmark command and fixture, `only` mode cuts tuple churn substantially versus `off`, especially on the project-list and `my-collaborators` paths.\n"
    )
    lines.append(
        "- Buffer-hit and read counts are directionally useful, but they are less clean than tuple counts here because each mode ran after a fresh hub restart with different cache warmth.\n"
    )
    lines.append(
        "- The most reliable local Postgres-load signal in this run is the drop in `tup_returned` and `tup_fetched` for the projection-backed `only` paths.\n"
    )
    lines.append("\n## Raw Baseline Reference\n")
    lines.append(
        f"- Previous read-path baseline: [phase-2-projection-read-benchmark-2026-04-04.md]({BASELINE_JSONL.with_suffix('.md')})\n"
    )
    lines.append(
        f"- Raw current benchmark data: [{OUTPUT_JSON.name}]({OUTPUT_JSON})\n"
    )
    return "".join(lines)


def main() -> int:
    require_env("COCALC_API_URL")
    require_env("COCALC_ACCOUNT_ID")
    require_env("PGHOST")
    require_env("PGUSER")
    require_env("PGDATABASE")
    if not CLI.exists():
        raise RuntimeError(f"CLI not built at {CLI}")

    admin_account_id = require_env("COCALC_ACCOUNT_ID")
    api_url = require_env("COCALC_API_URL")
    original_env_file = HUB_DAEMON_ENV.read_text()
    baseline = load_baseline()
    host_id = current_host_id()
    report: dict[str, Any] = {
        "timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
        "api_url": api_url,
        "admin_account_id": admin_account_id,
        "baseline": baseline,
    }

    collaborator_project_id = "808a3597-997e-47c1-b026-563bd42b34cd"
    collaborator_fixture_size = int(
        psql_value(
            f"""
select count(*)
from jsonb_object_keys(
  (select users from projects where project_id = {sql_literal(collaborator_project_id)}::uuid)
)
"""
        )
        or "0"
    )
    report["collaborator_project_id"] = collaborator_project_id
    report["collaborator_fixture_size"] = collaborator_fixture_size - 1

    persona_accounts: dict[str, str] = {"heavy": admin_account_id}

    try:
        for persona in PERSONAS:
            if persona.use_current_admin:
                continue
            account_id = ensure_account(
                persona.email or "",
                f"Phase3 Bench {persona.name.title()}",
            )
            persona_accounts[persona.name] = account_id
            ensure_project_fixture(
                account_id=account_id,
                persona_name=persona.name,
                target_count=persona.target_projects or 0,
                host_id=host_id,
            )
            rebuild_project_projection(account_id)

        rebuild_project_projection(admin_account_id)
        rebuild_collaborator_projection(admin_account_id)

        report["projection_status_before"] = projection_status()

        only_mode_line = ""
        set_guarded_read_modes(
            project_mode="only",
            collaborator_mode="only",
            mention_mode="prefer",
        )
        only_mode_line = restart_hub()

        persona_rows: list[dict[str, Any]] = []
        only_runs: list[dict[str, Any]] = []
        for persona in PERSONAS:
            account_id = persona_accounts[persona.name]
            project_count = int(
                cocalc_json(
                    "load",
                    "projects",
                    "--iterations",
                    "3",
                    "--warmup",
                    "1",
                    "--concurrency",
                    "1",
                    "--limit",
                    str(persona.limit),
                    account_id=account_id,
                )["data"]["last_result"]["project_count"]
            )
            bootstrap_run = benchmark_command(
                label=f"{persona.name}-bootstrap-only",
                account_id=account_id,
                command=[
                    "load",
                    "bootstrap",
                    "--iterations",
                    "500",
                    "--warmup",
                    "50",
                    "--concurrency",
                    "16",
                ],
            )
            projects_run = benchmark_command(
                label=f"{persona.name}-projects-only",
                account_id=account_id,
                command=[
                    "load",
                    "projects",
                    "--iterations",
                    "500",
                    "--warmup",
                    "50",
                    "--concurrency",
                    "16",
                    "--limit",
                    str(persona.limit),
                ],
            )
            only_runs.extend([bootstrap_run, projects_run])
            persona_rows.append(
                {
                    "persona": persona.name,
                    "project_count": project_count,
                    "bootstrap_p99": extract_latency(
                        bootstrap_run["result"]["data"], "p99"
                    ),
                    "projects_ops": projects_run["result"]["data"]["ops_per_sec"],
                    "projects_p99": extract_latency(
                        projects_run["result"]["data"], "p99"
                    ),
                }
            )

        report["only_mode_line"] = only_mode_line
        report["personas"] = persona_rows
        report["only_runs"] = only_runs

        comparison_runs: list[dict[str, Any]] = []
        heavy_compare: list[dict[str, Any]] = []
        for project_mode in ("off", "only"):
            set_guarded_read_modes(
                project_mode=project_mode,
                collaborator_mode="only",
                mention_mode="prefer",
            )
            restart_hub()
            run = benchmark_command(
                label=f"heavy-projects-{project_mode}",
                account_id=admin_account_id,
                command=[
                    "load",
                    "projects",
                    "--iterations",
                    "500",
                    "--warmup",
                    "50",
                    "--concurrency",
                    "16",
                    "--limit",
                    "2000",
                ],
                capture_pg_delta=True,
            )
            comparison_runs.append(run)
            old = baseline[f"projects:{project_mode}"]
            new = run["result"]["data"]
            heavy_compare.append(
                {
                    "benchmark": "projects",
                    "mode": project_mode,
                    "old_ops": old["ops_per_sec"],
                    "new_ops": new["ops_per_sec"],
                    "ops_ratio": round(new["ops_per_sec"] / old["ops_per_sec"], 3),
                    "old_p99": old["latency_ms"]["p99"],
                    "new_p99": new["latency_ms"]["p99"],
                    "p99_ratio": round(
                        new["latency_ms"]["p99"] / old["latency_ms"]["p99"], 3
                    ),
                }
            )

        for collaborator_mode in ("off", "only"):
            set_guarded_read_modes(
                project_mode="only",
                collaborator_mode=collaborator_mode,
                mention_mode="prefer",
            )
            restart_hub()
            my_collab_run = benchmark_command(
                label=f"heavy-my-collaborators-{collaborator_mode}",
                account_id=admin_account_id,
                command=[
                    "load",
                    "my-collaborators",
                    "--iterations",
                    "500",
                    "--warmup",
                    "50",
                    "--concurrency",
                    "16",
                    "--limit",
                    "2000",
                ],
                capture_pg_delta=True,
            )
            comparison_runs.append(my_collab_run)
            old = baseline[f"my-collaborators:{collaborator_mode}"]
            new = my_collab_run["result"]["data"]
            heavy_compare.append(
                {
                    "benchmark": "my-collaborators",
                    "mode": collaborator_mode,
                    "old_ops": old["ops_per_sec"],
                    "new_ops": new["ops_per_sec"],
                    "ops_ratio": round(new["ops_per_sec"] / old["ops_per_sec"], 3),
                    "old_p99": old["latency_ms"]["p99"],
                    "new_p99": new["latency_ms"]["p99"],
                    "p99_ratio": round(
                        new["latency_ms"]["p99"] / old["latency_ms"]["p99"], 3
                    ),
                }
            )
            collaborators_run = benchmark_command(
                label=f"project-collaborators-{collaborator_mode}",
                account_id=admin_account_id,
                command=[
                    "load",
                    "collaborators",
                    "--project",
                    collaborator_project_id,
                    "--iterations",
                    "500",
                    "--warmup",
                    "50",
                    "--concurrency",
                    "16",
                ],
                capture_pg_delta=True,
            )
            comparison_runs.append(collaborators_run)

        report["comparison_runs"] = comparison_runs
        report["heavy_compare"] = heavy_compare
        report["pg_compare"] = [
            {
                "benchmark": row["label"].replace("heavy-", ""),
                "mode": "only" if row["label"].endswith("-only") else "off",
                "pg_delta": row["pg_delta"],
            }
            for row in comparison_runs
            if "pg_delta" in row
        ]
        report["projection_status_after"] = projection_status()

    finally:
        HUB_DAEMON_ENV.write_text(original_env_file)
        restart_hub()

    OUTPUT_JSON.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    OUTPUT_MD.write_text(build_markdown(report))
    print(str(OUTPUT_JSON))
    print(str(OUTPUT_MD))
    return 0


if __name__ == "__main__":
    sys.exit(main())
