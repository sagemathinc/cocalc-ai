/*
run a persist server
*/

const { conat } = require('@cocalc/backend/conat')
const {
  installPersistExitGuard,
  installPersistSignalFlush,
} = require('@cocalc/backend/conat/persist');
const {server} = require('@cocalc/conat/persist/server');

async function main() {
  // 028 E-1: a natural exit must not close (and checkpoint) the disk streams
  installPersistExitGuard();
  // 028 B-3a: a signal commits the queued writes, then ends as before
  installPersistSignalFlush();
  const client = await conat()
  server({client});
}

main();
