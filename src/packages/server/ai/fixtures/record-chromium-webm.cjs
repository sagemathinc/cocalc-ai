// Run from src/packages with: node server/ai/fixtures/record-chromium-webm.cjs
// Synthetic tone only: no microphone, network, or provider calls.
const { createRequire } = require("node:module");
const { chromium } = createRequire(
  require.resolve("../../../frontend/package.json"),
)("@playwright/test");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await browser.newPage();
    const bytes = await page.evaluate(async () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      const recorder = new MediaRecorder(destination.stream, {
        mimeType: "audio/webm;codecs=opus",
      });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start(250);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      recorder.stop();
      await stopped;
      oscillator.stop();
      destination.stream.getTracks().forEach((track) => track.stop());
      await context.close();
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    });
    writeFileSync(
      join(__dirname, "chromium-streaming-opus.webm"),
      Buffer.from(bytes),
    );
    process.stdout.write(`${await browser.version()}: ${bytes.length} bytes\n`);
  } finally {
    await browser.close();
  }
})();
