process.env.COCALC_TEST_MODE = "true";
// Hub tests should always run as if the hub is mounted at URL root.
// This prevents ambient project-shell BASE_PATH inference from changing
// stripBasePath() behavior and making proxy tests environment-dependent.
process.env.BASE_PATH = "/";
