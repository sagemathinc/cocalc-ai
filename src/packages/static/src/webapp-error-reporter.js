/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS104: Avoid inline assignments
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/main/docs/suggestions.md
 */
//########################################################################
// This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
// License: MS-RSL – see LICENSE.md for details
//########################################################################

// Catch and report webapp client errors to the SMC server.
// This is based on bugsnag's MIT licensed lib: https://github.com/bugsnag/bugsnag-js
// The basic idea is to wrap very early at a very low level of the event system,
// such that all libraries loaded later are sitting on top of this.
// Additionally, special care is taken to browser brands and their capabilities.
// Finally, additional data about the webapp client is gathered and sent with the error report.

// list of string-identifyers of errors, that were already reported.
// this avoids excessive resubmission of errors
let ENABLED;
const already_reported = [];

// set this to true, to enable the webapp error reporter for development
const enable_for_testing = false;
if (typeof BACKEND !== "undefined" && BACKEND) {
  // never enable on the backend -- used by static react rendering.
  ENABLED = false;
} else {
  ENABLED = !DEBUG || enable_for_testing;
}

// this is the MAIN function of this module
// it's exported publicly and also used in various spots where exceptions are already
// caught and reported to the browser's console.
const reportException = function (exception, name, severity, comment) {
  if (!exception || typeof exception === "string") {
    return;
  }
  // setting those *Number defaults to `undefined` breaks somehow on its way
  // to the DB (it only wants NULL or an int). -1 is signaling that there is no info.
  return sendError({
    name: name || exception.name,
    message: exception.message || exception.description,
    comment: comment != null ? comment : "",
    stacktrace: stacktraceFromException(exception) || generateStacktrace(),
    file: exception.fileName || exception.sourceURL,
    path: window.location.href,
    lineNumber: exception.lineNumber || exception.line || -1,
    columnNumber: exception.columnNumber || -1,
    severity: severity || "default",
  });
};

const WHITELIST = [
  "componentWillMount has been renamed",
  "componentWillReceiveProps has been renamed",
  // Ignore this antd message in browser:
  "a whole package of antd",
  // we can't do anything about bokeh crashes in their own code
  "cdn.bokeh.org",
  // xtermjs
  "renderRows",
  "Viewport.syncScrollArea",
];
const isWhitelisted = function (opts) {
  const s = JSON.stringify(opts);
  for (let x of WHITELIST) {
    if (s.indexOf(x) !== -1) {
      return true;
    }
  }
  return false;
};

// this is the final step sending the error report.
// it gathers additional information about the webapp client.
let currentlySendingError = false;
const sendError = async function (opts) {
  // console.log("sendError", currentlySendingError, opts);
  if (currentlySendingError) {
    // errors can be crazy and easily DOS the user's connection.  Since this table is
    // just something we manually check sometimes, not sending too many errors is
    // best.  We send at most one at a time.  See https://github.com/sagemathinc/cocalc/issues/5771
    return;
  }
  currentlySendingError = true;
  try {
    //console.log 'sendError', opts
    let webapp_client;
    if (isWhitelisted(opts)) {
      //console.log 'sendError: whitelisted'
      return;
    }
    const misc = require("@cocalc/util/misc");
    opts = misc.defaults(opts, {
      name: misc.required,
      message: misc.required,
      comment: "",
      stacktrace: "",
      file: "",
      path: "",
      lineNumber: -1,
      columnNumber: -1,
      severity: "default",
    });
    const fingerprint = misc.uuidsha1(
      [opts.name, opts.message, opts.comment].join("::"),
    );
    if (already_reported.includes(fingerprint) && !DEBUG) {
      return;
    }
    already_reported.push(fingerprint);
    // attaching some additional info
    const feature = require("@cocalc/frontend/feature");
    opts.user_agent = navigator?.userAgent;
    opts.browser = feature.get_browser();
    opts.mobile = feature.IS_MOBILE;
    opts.smc_version = SMC_VERSION;
    opts.build_date = BUILD_DATE;
    opts.smc_git_rev = COCALC_GIT_REVISION;
    opts.uptime = misc.get_uptime();
    opts.start_time = misc.get_start_time_ts();
    if (DEBUG) {
      console.info("error reporter sending:", opts);
    }
    try {
      // During initial load in some situations evidently webapp_client
      // is not yet initialized, and webapp_client is undefined.  (Maybe
      // a typescript rewrite of everything relevant will help...).  In
      // any case, for now we
      //   https://github.com/sagemathinc/cocalc/issues/4769
      // As an added bonus, by try/catching and retrying once at least,
      // we are more likely to get the error report in case of a temporary
      // network or other glitch....
      // console.log("sendError: import webapp_client");

      ({ webapp_client } = require("@cocalc/frontend/webapp-client")); // can possibly be undefined
      // console.log 'sendError: sending error'
      return await webapp_client.tracking_client.webapp_error(opts); // might fail.
      // console.log 'sendError: got response'
    } catch (err) {
      console.info(
        "failed to report error; trying again in 30 seconds",
        err,
        opts,
      );
      const { delay } = require("awaiting");
      await delay(30000);
      try {
        ({ webapp_client } = require("@cocalc/frontend/webapp-client"));
        return await webapp_client.tracking_client.webapp_error(opts);
      } catch (error) {
        err = error;
        return console.info("failed to report error", err);
      }
    }
  } finally {
    currentlySendingError = false;
  }
};

// neat trick to get a stacktrace when there is none
var generateStacktrace = function () {
  try {
    throw new Error("");
  } catch (exception) {
    return `<generated>\n${stacktraceFromException(exception) || ""}`;
  }
  return "<generated>\n";
};

var stacktraceFromException = (exception) =>
  exception.stack || exception.backtrace || exception.stacktrace;

if (ENABLED) {
  const previousOnError = window.onerror;
  window.onerror = function (message, url, lineNo, charNo, exception) {
    // IE 6+ support.
    if (!charNo && window.event) {
      charNo = window.event.errorCharacter;
    }

    const name = exception?.name || "window.onerror";
    const stacktrace =
      (exception && stacktraceFromException(exception)) || generateStacktrace();
    sendError({
      name,
      message,
      file: url,
      path: window.location.href,
      lineNumber: lineNo,
      columnNumber: charNo,
      stacktrace,
      severity: "error",
    });

    if (typeof previousOnError === "function") {
      return previousOnError(message, url, lineNo, charNo, exception);
    }
  };
}

if (ENABLED) {
  window.addEventListener("unhandledrejection", (e) => {
    // just to make sure there is a message
    let reason = e.reason != null ? e.reason : "<no reason>";
    if (typeof reason === "object") {
      let left;
      const misc = require("@cocalc/util/misc");
      reason = `${
        (left = reason.stack != null ? reason.stack : reason.message) != null
          ? left
          : misc.trunc_middle(misc.to_json(reason), 1000)
      }`;
    }
    e.message = `unhandledrejection: ${reason}`;
    reportException(e, "unhandledrejection");
  });
}

// public API

exports.reportException = reportException;

if (DEBUG) {
  if (window.cc == null) {
    window.cc = {};
  }
  window.cc.webapp_error_reporter = {
    shouldCatch() {
      return false;
    },
    already_reported() {
      return already_reported;
    },
    stacktraceFromException,
    generateStacktrace,
    reportException,
    is_enabled() {
      return ENABLED;
    },
  };
}
