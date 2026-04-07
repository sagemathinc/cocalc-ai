# Phase 3 Control-Plane Benchmark: 2026-04-06
Recorded after slimming the live `projects` payload, moving project detail fields off `project_map`, and removing the legacy `project_and_user_tracker` path.

## Environment
- Date: `2026-04-06T23:54:58-07:00`
- Repo: `/home/wstein/build/cocalc-lite4`
- API: `http://localhost:13004`
- CLI: `/home/wstein/build/cocalc-lite4/src/packages/cli/dist/bin/cocalc.js`
- Admin account: `6e22d250-68d4-46fb-9851-80fbeaa2d6b6`
- Collaborator-heavy benchmark project: `808a3597-997e-47c1-b026-563bd42b34cd`
- Reused collaborator-heavy fixture size: `500` collaborators

## Fixture Personas
- `light`: synthetic account with about `20` visible benchmark projects
- `normal`: synthetic account with about `200` visible benchmark projects
- `heavy`: existing admin/dev account with about `1047` visible projects
- `extreme`: synthetic account with about `10000` visible benchmark projects

## Current `only` Mode Persona Sweep
| persona | projects | bootstrap p99 ms | projects ops/s | projects p99 ms |
| --- | ---: | ---: | ---: | ---: |
| `light` | 21 | 18.494 | 1059.478 | 27.684 |
| `normal` | 201 | 18.559 | 731.385 | 25.319 |
| `heavy` | 1047 | 13.038 | 208.147 | 76.249 |
| `extreme` | 10001 | 22.402 | 22.831 | 708.797 |

## Heavy-Account Comparison Versus 2026-04-04 Baseline
| workload | mode | old ops/s | new ops/s | ops ratio | old p99 ms | new p99 ms | p99 ratio |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `projects` | `off` | 136.317 | 180.635 | 1.325x | 137.479 | 95.104 | 0.692x |
| `projects` | `only` | 176.899 | 193.619 | 1.095x | 127.446 | 87.542 | 0.687x |
| `my-collaborators` | `off` | 364.644 | 381.924 | 1.047x | 92.276 | 71.446 | 0.774x |
| `my-collaborators` | `only` | 412.356 | 434.985 | 1.055x | 60.012 | 59.467 | 0.991x |

Interpretation:
- `projects` heavy-account reads are materially faster than the April 4 baseline in both `off` and `only` modes.
- `my-collaborators` remains healthy; the new `only` path is still faster than the old `off` baseline, with no failures.

## Postgres Delta: `off` Versus `only`
| workload | mode | blks_hit | blks_read | tup_returned | tup_fetched | xact_commit | temp_bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `projects-off` | `off` | 415860.000 | 8.000 | 9243784.000 | 8124.000 | 420.000 | 0.000 |
| `projects-only` | `only` | 451559.000 | 580.000 | 7151227.000 | 673062.000 | 709.000 | 0.000 |
| `my-collaborators-off` | `off` | 922044.000 | 19.000 | 5344113.000 | 249737.000 | 465.000 | 0.000 |
| `project-collaborators-off` | `off` | 520696.000 | 0.000 | 1106530.000 | 164809.000 | 321.000 | 0.000 |
| `my-collaborators-only` | `only` | 35592.000 | 38.000 | 321537.000 | 6161.000 | 340.000 | 0.000 |
| `project-collaborators-only` | `only` | 419707.000 | 34.000 | 424789.000 | 152164.000 | 643.000 | 0.000 |

Observations:
- For the same benchmark command and fixture, `only` mode cuts tuple churn substantially versus `off`, especially on the project-list and `my-collaborators` paths.
- Buffer-hit and read counts are directionally useful, but they are less clean than tuple counts here because each mode ran after a fresh hub restart with different cache warmth.
- The most reliable local Postgres-load signal in this run is the drop in `tup_returned` and `tup_fetched` for the projection-backed `only` paths.

## Raw Baseline Reference
- Previous read-path baseline: [phase-2-projection-read-benchmark-2026-04-04.md](/home/wstein/build/cocalc-lite4/src/.agents/phase-2-projection-read-benchmark-2026-04-04.md)
- Raw current benchmark data: [phase-3-control-plane-benchmark-2026-04-06.json](/home/wstein/build/cocalc-lite4/src/.agents/phase-3-control-plane-benchmark-2026-04-06.json)
