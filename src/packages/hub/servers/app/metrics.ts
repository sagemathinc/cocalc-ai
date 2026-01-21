/*
Express middleware for recording metrics about response time to requests.
*/

import { dirname } from "path";
import { Router } from "express";
import { get, new_histogram } from "@cocalc/server/metrics/metrics-recorder";
import { join } from "path";
import basePath from "@cocalc/backend/base-path";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getLogger } from "@cocalc/hub/logger";
import { isIpAllowed, parseAllowlist } from "@cocalc/util/ip-allowlist";

const log = getLogger("metrics");

// initialize metrics
const responseTimeHistogram = new_histogram("http_histogram", "http server", {
  buckets: [0.01, 0.1, 1, 2, 5, 10, 20],
  labels: ["path", "method", "code"],
});

// response time metrics
function metrics(req, res, next) {
  const resFinished = responseTimeHistogram.startTimer();
  const originalEnd = res.end;
  res.end = (...args) => {
    originalEnd.apply(res, args);
    if (!req.path) {
      return;
    }
    // for regular paths, we ignore the file
    const path = dirname(req.path).split("/").slice(0, 2).join("/");
    resFinished({
      path,
      method: req.method,
      code: res.statusCode,
    });
  };
  next();
}

export function setupInstrumentation(router: Router) {
  router.use(metrics);
}

export function initMetricsEndpoint(router: Router) {
  const endpoint = join(basePath, "metrics");
  log.info("initMetricsEndpoint at ", endpoint);

  router.get(endpoint, async (req, res) => {
    res.header("Content-Type", "text/plain");
    res.header("Cache-Control", "no-cache, no-store");
    const settings = await getServerSettings();
    if (!settings.prometheus_metrics) {
      res.status(403).json({
        error:
          "Sharing of metrics at /metrics is disabled. Metrics can be enabled in the site administration page.",
      });
      return;
    }
    const allowlist = parseAllowlist(settings.prometheus_metrics_allowlist);
    if (!isIpAllowed(req.ip, allowlist)) {
      res.status(403).json({ error: "Metrics access denied." });
      return;
    }
    const metricsRecorder = get();
    if (metricsRecorder != null) {
      res.send(await metricsRecorder.metrics());
    } else {
      res.json({ error: "Metrics recorder not initialized." });
    }
  });
}
