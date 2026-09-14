# Historical PostgreSQL Crontab

This is a legacy schedule retained as historical context. The referenced
`smc-backup-postgres` and `smc-backup-postgres-all` scripts are absent from the
current source tree. This is not an installation recipe or evidence of a
currently running backup schedule.

```text

# Dump and snapshot critical tables every 6 hours.
0 */6 * * * /home/salvus/smc/src/scripts/postgresql/smc-backup-postgres 1>/home/salvus/.smc-backup-postgres.log 2>/home/salvus/.smc-backup-postgres.err

# Dump entire database once per week (Saturday)
30 4 * * 6 /home/salvus/smc/src/scripts/postgresql/smc-backup-postgres-all 1>/home/salvus/.smc-backup-postgres-all.log 2>/home/salvus/.smc-backup-postgres-all.err
```
