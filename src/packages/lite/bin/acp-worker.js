#!/usr/bin/env node

require("@cocalc/lite/acp-worker")
  .main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
