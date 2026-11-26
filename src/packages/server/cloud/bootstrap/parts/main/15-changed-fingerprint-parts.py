def changed_fingerprint_parts(
    before: dict[str, str], after: dict[str, str]
) -> list[str]:
    return sorted(
        key for key in set(before) | set(after) if before.get(key) != after.get(key)
    )


def project_host_running(cfg: BootstrapConfig) -> bool:
    ctl_path = project_host_runtime_root(cfg) / "bin" / "ctl"
    if not ctl_path.exists():
        return False
    status = run_cmd(
        cfg,
        [str(ctl_path), "status"],
        "project-host status",
        check=False,
        as_user=cfg.ssh_user,
        cwd=runtime_home(cfg),
    )
    return status.returncode == 0


def start_project_host(cfg: BootstrapConfig) -> None:
    ctl_path = str(project_host_runtime_root(cfg) / "bin" / "ctl")
    ctl_cwd = runtime_home(cfg)
    # Sanity check: bundle must contain a compiled entrypoint.
    bundle_candidates = [
        Path(cfg.project_host_bundle.current) if cfg.project_host_bundle.current else None,
        Path(cfg.project_host_bundle.dir) if cfg.project_host_bundle.dir else None,
    ]
    bundle_candidates = [p for p in bundle_candidates if p]
    entry_candidates = [
        Path("bundle") / "index.js",
        Path("main") / "index.js",
        Path("dist") / "main.js",
    ]
    entry_found = None
    for root in bundle_candidates:
        for rel in entry_candidates:
            candidate = root / rel
            if candidate.exists():
                entry_found = candidate
                break
        if entry_found:
            break
    if not entry_found:
        roots = ", ".join(str(p) for p in bundle_candidates if p) or "unknown"
        log_line(cfg, f"bootstrap: missing project-host entrypoint (searched: bundle/index.js, main/index.js, dist/main.js) in {roots}")
        log_line(cfg, "bootstrap: project-host bundle appears incomplete; re-run bundle build/publish and re-bootstrap")
        raise RuntimeError("project-host bundle missing entrypoint")
    ensure_runtime_user_manager(cfg)
    if Path(ctl_path).exists():
        run_cmd(
            cfg,
            [ctl_path, "stop"],
            "project-host stop",
            check=False,
            as_user=cfg.ssh_user,
            cwd=ctl_cwd,
        )
    result = run_cmd(
        cfg,
        [ctl_path, "start"],
        "project-host start",
        check=False,
        as_user=cfg.ssh_user,
        cwd=ctl_cwd,
    )
    if result.returncode == 0:
        return
    output = result.stdout or ""
    if "already running" in output:
        log_line(
            cfg,
            "bootstrap: project-host reported already running after start; "
            "verifying current instance with daemon ensure",
        )
        run_cmd(
            cfg,
            [ctl_path, "ensure"],
            "project-host ensure",
            as_user=cfg.ssh_user,
            cwd=ctl_cwd,
        )
        return
    status = run_cmd(
        cfg,
        [ctl_path, "status"],
        "project-host status after failed start",
        check=False,
        as_user=cfg.ssh_user,
        cwd=ctl_cwd,
    )
    if status.returncode == 0:
        log_line(
            cfg,
            "bootstrap: project-host start failed, but status reports running; "
            "treating the daemon as healthy",
        )
        return
    raise RuntimeError(f"project-host start failed with exit code {result.returncode}")


def touch_paths(paths: list[str]) -> None:
    for path in paths:
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).touch()
        except Exception:
            pass


def run_provision(cfg: BootstrapConfig) -> int:
    log_line(cfg, "bootstrap: starting provision")
    # Before anything is written beneath /var/lib/cocalc by name.
    ensure_cocalc_state_root(cfg)
    report_bootstrap_status(cfg, "running", "Preparing bootstrap environment")
    record_operation_start(cfg, "provision")
    try:
        ensure_runtime_user(cfg)
        ensure_bootstrap_paths(cfg)
        ensure_platform(cfg)
        image_size_gb = compute_image_size(cfg)
        disable_unattended(cfg)
        report_bootstrap_status(cfg, "running", "Installing Ubuntu packages")
        apt_update_install(cfg)
        configure_kernel_module_hardening(cfg)
        configure_kernel_sysctl_hardening(cfg)
        configure_kernel_key_limits(cfg)
        configure_inotify_limits(cfg)
        report_bootstrap_status(cfg, "running", "Configuring storage and containers")
        install_gpu_support(cfg)
        configure_chrony(cfg)
        configure_journald_limits(cfg)
        configure_rsyslog_limits(cfg)
        enable_userns(cfg)
        ensure_subuids(cfg)
        enable_linger(cfg)
        ensure_runtime_user_manager(cfg)
        prepare_dirs(cfg)
        setup_btrfs(cfg, image_size_gb)
        setup_shared_scratch(cfg)
        record_operation_success(cfg, "provision")
        log_line(cfg, "bootstrap: provision completed successfully")
        return 0
    except Exception as exc:
        record_operation_failure(cfg, "provision", str(exc))
        raise


def run_reconcile(cfg: BootstrapConfig, restart_if_changed: bool = False) -> int:
    log_line(cfg, "bootstrap: starting reconcile")
    # Before anything is written beneath /var/lib/cocalc by name.
    ensure_cocalc_state_root(cfg)
    report_bootstrap_status(cfg, "running", "Reconciling host software")
    record_operation_start(cfg, "reconcile")
    # At boot, systemd has already started the stack; restarting it again
    # minutes later interrupted users and freshly resumed agent turns.
    fingerprint_before = (
        project_host_restart_fingerprint(cfg) if restart_if_changed else None
    )
    try:
        ensure_runtime_user(cfg)
        ensure_bootstrap_paths(cfg)
        ensure_automatic_security_updates(cfg)
        configure_daily_root_cleanup(cfg)
        configure_host_integrity_watch(cfg)
        configure_btrfs_scrub(cfg)
        configure_kernel_module_hardening(cfg)
        configure_kernel_sysctl_hardening(cfg)
        configure_kernel_key_limits(cfg)
        configure_inotify_limits(cfg)
        configure_journald_limits(cfg)
        configure_rsyslog_limits(cfg)
        image_size_gb = compute_image_size(cfg)
        install_btrfs_helper(cfg)
        install_privileged_wrappers(cfg)
        migrate_image_root_links(cfg)
        reconcile_storage_and_containment(cfg)
        ensure_subuids(cfg)
        ensure_runtime_user_manager(cfg)
        if cfg.container_runtime_bundle is not None:
            report_bootstrap_status(
                cfg, "running", "Installing container runtime"
            )
            extract_bundle(cfg, cfg.container_runtime_bundle)
        # stopped before the config changes, so no root podman runs meanwhile
        disable_root_podman_units(cfg)
        configure_podman(cfg)
        verify_runtime_user_contract(cfg)
        write_env(cfg, image_size_gb)
        ensure_runtime_user_manager(cfg)
        configure_runtime_shell_env(cfg)
        setup_master_conat_token(cfg)
        report_bootstrap_status(cfg, "running", "Downloading CoCalc software bundles")
        extract_bundle(cfg, cfg.project_host_bundle)
        extract_bundle(cfg, cfg.project_bundle)
        tools_bundle = extract_bundle(cfg, cfg.tools_bundle)
        install_privileged_tool_binaries(cfg, tools_bundle)
        report_bootstrap_status(cfg, "running", "Installing runtime tools")
        install_node(cfg)
        install_node_runtime_libs(cfg)
        configure_node_bind_service_capability(cfg)
        write_wrapper(cfg)
        write_helpers(cfg)
        configure_runtime_sudoers(cfg)
        verify_runtime_sudoers(cfg)
        configure_cloudflared_with_options(cfg, install_package=False)
        configure_critical_service_oom_protection(cfg)
        configure_autostart(cfg)
        keep_running = False
        if fingerprint_before is not None:
            changed = changed_fingerprint_parts(
                fingerprint_before, project_host_restart_fingerprint(cfg)
            )
            if changed:
                log_line(
                    cfg,
                    "bootstrap: project-host software changed ("
                    + ", ".join(changed)
                    + "); restarting the stack",
                )
            elif not project_host_running(cfg):
                log_line(cfg, "bootstrap: project-host not running; starting it")
            else:
                keep_running = True
                log_line(
                    cfg,
                    "bootstrap: project-host software unchanged and running; "
                    "leaving the running stack alone",
                )
        if not keep_running:
            report_bootstrap_status(
                cfg, "running", "Restarting project-host services"
            )
            start_project_host(cfg)
        # The egress block exempts the conat router port from the daemon's
        # env files, which write_env may have changed after the containment
        # pass above. A changed key also restarts the stack (the fingerprint
        # covers both files), so rebuild the rules for the env it now runs with.
        reconcile_project_network_limits(cfg)
        record_operation_success(cfg, "reconcile")
        report_bootstrap_status(cfg, "done", "Host software reconciled")
        log_line(cfg, "bootstrap: reconcile completed successfully")
        return 0
    except Exception as exc:
        record_operation_failure(cfg, "reconcile", str(exc))
        raise


def run_reconcile_helpers(cfg: BootstrapConfig) -> int:
    log_line(cfg, "bootstrap: starting helper-only reconcile")
    # Before anything is written beneath /var/lib/cocalc by name.
    ensure_cocalc_state_root(cfg)
    report_bootstrap_status(cfg, "running", "Reconciling privileged host helpers")
    record_operation_start(cfg, "reconcile")
    try:
        ensure_runtime_user(cfg)
        ensure_bootstrap_paths(cfg)
        configure_rsyslog_limits(cfg)
        configure_daily_root_cleanup(cfg)
        configure_host_integrity_watch(cfg)
        configure_btrfs_scrub(cfg)
        configure_kernel_sysctl_hardening(cfg)
        disable_root_podman_units(cfg)
        install_privileged_wrappers(cfg)
        migrate_image_root_links(cfg)
        install_privileged_tool_binaries(cfg)
        write_helpers(cfg)
        configure_runtime_sudoers(cfg)
        verify_runtime_sudoers(cfg)
        configure_autostart(cfg)
        reconcile_bees_runtime_policy(cfg)
        reconcile_project_network_limits(cfg)
        reconcile_project_io_policy(cfg)
        reconcile_host_service_cgroup(cfg)
        configure_cloudflared_with_options(cfg, install_package=False)
        record_operation_success(cfg, "reconcile")
        report_bootstrap_status(cfg, "done", "Privileged host helpers reconciled")
        log_line(cfg, "bootstrap: helper-only reconcile completed successfully")
        return 0
    except Exception as exc:
        record_operation_failure(cfg, "reconcile", str(exc))
        raise


def run_reconcile_environment(cfg: BootstrapConfig) -> int:
    log_line(cfg, "bootstrap: starting environment-only reconcile")
    # Before anything is written beneath /var/lib/cocalc by name.
    ensure_cocalc_state_root(cfg)
    report_bootstrap_status(
        cfg, "running", "Reconciling managed project-host environment"
    )
    record_operation_start(cfg, "reconcile")
    try:
        ensure_runtime_user(cfg)
        ensure_bootstrap_paths(cfg)
        image_size_gb = compute_image_size(cfg)
        write_env(cfg, image_size_gb)
        write_bootstrap_state_files(cfg)
        # No network reconcile here: the running daemon keeps its conat port
        # until it restarts, and its reconciler rebuilds the egress rules from
        # the env files it loaded on its first pass after starting.
        record_operation_success(cfg, "reconcile")
        report_bootstrap_status(
            cfg, "done", "Managed project-host environment reconciled"
        )
        log_line(cfg, "bootstrap: environment-only reconcile completed successfully")
        return 0
    except Exception as exc:
        record_operation_failure(cfg, "reconcile", str(exc))
        raise


def run_bootstrap(cfg: BootstrapConfig) -> int:
    run_provision(cfg)
    run_reconcile(cfg)
    report_bootstrap_status(cfg, "running", "Starting project-host services")
    start_project_host(cfg)
    report_bootstrap_status(cfg, "running", "Finalizing bootstrap")
    mark_bootstrap_done(cfg)
    write_bootstrap_state_files(cfg)
    log_line(cfg, "bootstrap: completed successfully")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        nargs="?",
        default="bootstrap",
        choices=[
            "bootstrap",
            "provision",
            "reconcile",
            "helpers",
            "environment",
            "status",
        ],
    )
    parser.add_argument("--bootstrap-dir")
    parser.add_argument("--config", help=argparse.SUPPRESS)
    parser.add_argument(
        "--restart-if-changed",
        action="store_true",
        help="reconcile: keep a running project-host unless its software changed",
    )
    parser.add_argument(
        "--only",
        help="Comma-separated subset (container_runtime_bundle, project_bundle, project_host_bundle, tools_bundle, cloudflared)",
    )
    args = parser.parse_args(argv)
    bootstrap_dir = args.bootstrap_dir
    if not bootstrap_dir and args.config:
        bootstrap_dir = str(Path(args.config).resolve().parent)
    if not bootstrap_dir:
        parser.error("one of --bootstrap-dir or --config is required")
    cfg = load_config(bootstrap_dir)
    # Every mode writes beneath /var/lib/cocalc by name (lifecycle export,
    # status): make it root's first.
    ensure_cocalc_state_root(cfg)
    only = parse_only(args.only)
    log_line(cfg, "bootstrap: starting python bootstrap")
    log_line(cfg, f"bootstrap: user={cfg.bootstrap_user} home={cfg.bootstrap_home} root={cfg.bootstrap_root}")
    try:
        if only:
            with bootstrap_operation_lock(cfg):
                ensure_runtime_user(cfg)
                ensure_bootstrap_paths(cfg)
                write_bootstrap_state_files(cfg)
                log_line(cfg, f"bootstrap: running subset {sorted(only)}")
                if "project_host_bundle" in only:
                    extract_bundle(cfg, cfg.project_host_bundle)
                    write_wrapper(cfg)
                    write_helpers(cfg)
                if (
                    "container_runtime_bundle" in only
                    and cfg.container_runtime_bundle is not None
                ):
                    extract_bundle(cfg, cfg.container_runtime_bundle)
                if "project_bundle" in only:
                    extract_bundle(cfg, cfg.project_bundle)
                if "tools_bundle" in only:
                    tools_bundle = extract_bundle(cfg, cfg.tools_bundle)
                    install_privileged_tool_binaries(cfg, tools_bundle)
                if "cloudflared" in only:
                    configure_cloudflared_with_options(cfg, install_package=False)
                write_bootstrap_state_files(cfg)
                return 0
        if args.mode == "status":
            # Status republishes cleanup capability, so it must wait for any
            # older bootstrap invocation to finish before enabling deletion.
            with bootstrap_operation_lock(cfg):
                cfg = load_config(bootstrap_dir)
                write_bootstrap_state_files(cfg)
                sys.stdout.write(
                    json.dumps(json_load(bootstrap_state_path(cfg)), indent=2, sort_keys=True)
                    + "\n"
                )
            return 0
        if args.mode == "provision":
            with bootstrap_operation_lock(cfg):
                return run_provision(cfg)
        if args.mode == "reconcile":
            with bootstrap_operation_lock(cfg):
                cfg = load_config(bootstrap_dir)
                if args.restart_if_changed:
                    rc = run_reconcile(cfg, restart_if_changed=True)
                else:
                    rc = run_reconcile(cfg)
                if rc == 0:
                    finish_successful_run(cfg)
                return rc
        if args.mode == "helpers":
            with bootstrap_operation_lock(cfg):
                cfg = load_config(bootstrap_dir)
                rc = run_reconcile_helpers(cfg)
                if rc == 0:
                    finish_successful_run(cfg)
                return rc
        if args.mode == "environment":
            with bootstrap_operation_lock(cfg):
                cfg = load_config(bootstrap_dir)
                rc = run_reconcile_environment(cfg)
                if rc == 0:
                    finish_successful_run(cfg)
                return rc
        with bootstrap_operation_lock(cfg):
            cfg = load_config(bootstrap_dir)
            rc = run_bootstrap(cfg)
            if rc == 0:
                finish_successful_run(cfg)
            return rc
    except Exception as exc:
        log_line(cfg, f"bootstrap: failed: {exc}")
        # Bootstrap may fail before the host can heartbeat its local state.
        # Do not leave the control plane displaying the last running phase.
        report_bootstrap_status(cfg, "error", str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
