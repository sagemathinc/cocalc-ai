const Kernel = require("../stateless-api/kernel").default;
const { closeAll } = require("../kernel/launch-kernel");

afterAll(async () => {
  try {
    await Kernel.closeAllAndWait();
  } catch {
    // best-effort test cleanup
  }
  try {
    closeAll();
  } catch {
    // best-effort test cleanup
  }
});
