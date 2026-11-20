// finding 028 (ops0's NOFILE ruling, 2026-11-18): TEST ONLY.  The hard NOFILE
// limit of the machine that runs these suites can be below the persist's
// MIN_NOFILE, so the disk-stream suites -- and the child processes some of
// them spawn -- give their persist context a start-up check built with a
// lower minimum, passed explicitly.  Production code never loads this file;
// the production wiring and its MIN_NOFILE are tested with nothing injected
// (durable-startup-checks: [NOFILE-prod], [NOFILE-leak]).
//
// durability: the persist-durability module of the caller's module registry
// (the source under jest, the dist in a child process).

const TEST_NOFILE_MINIMUM = 1024;

function testPersistStartupCheck(durability) {
  return durability.makePersistStartupCheck(TEST_NOFILE_MINIMUM);
}

// the persist context of persist.ts, with the test start-up check (extra:
// more options, e.g. a guarded write counter)
function installTestPersistStartupCheck({ persist, durability, context, extra = {} }) {
  context.initContext({
    ...persist.persistContextOptions,
    startupCheck: testPersistStartupCheck(durability),
    ...extra,
  });
}

module.exports = {
  TEST_NOFILE_MINIMUM,
  testPersistStartupCheck,
  installTestPersistStartupCheck,
};
