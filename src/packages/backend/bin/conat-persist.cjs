/*
run a persist server
*/

const { conat } = require('@cocalc/backend/conat')
const { installPersistExitGuard } = require('@cocalc/backend/conat/persist');
const {server} = require('@cocalc/conat/persist/server');

async function main() {
  // 028 E-1: a natural exit must not close (and checkpoint) the disk streams
  installPersistExitGuard();
  const client = await conat()
  server({client});
}

main();
