require("@testing-library/jest-dom");
const { TextEncoder, TextDecoder } = require("node:util");
Object.assign(globalThis, { TextEncoder, TextDecoder });
process.env.COCALC_TEST_MODE = true;
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = jest.fn();
}
