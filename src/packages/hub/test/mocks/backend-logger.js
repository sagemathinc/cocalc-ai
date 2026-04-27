function noop() {}

function createLogger() {
  return {
    error: noop,
    warn: noop,
    info: noop,
    http: noop,
    debug: noop,
    silly: noop,
    verbose: noop,
    extend: () => createLogger(),
    isEnabled: () => false,
  };
}

module.exports = createLogger;
module.exports.default = createLogger;
module.exports.getLogger = createLogger;
module.exports.trimLogFileSize = noop;
module.exports.setCounter = noop;
