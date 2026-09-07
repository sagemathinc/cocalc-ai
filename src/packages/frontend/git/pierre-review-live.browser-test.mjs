// Real application/Slate smoke test through an isolated Chrome target. The raw
// page CDP connection avoids attaching to every preexisting maintainer tab.
// Usage: node .../pierre-review-live.browser-test.mjs <chat-url> <commit>
import assert from "node:assert/strict";

const [chat, commit] = process.argv.slice(2);
if (!chat || !/^[a-f0-9]{7,64}$/i.test(commit ?? ""))
  throw Error("Supply an isolated chat URL and a commit in its repository.");
const endpoint = process.env.CDP_URL ?? "http://localhost:9222";
const target = await (
  await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })
).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let sequence = 0;
const requests = new Map();
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) requests.get(message.id)?.(message);
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(Error(`CDP timeout: ${method}`));
    }, 15000);
    requests.set(id, (message) => {
      clearTimeout(timer);
      requests.delete(id);
      if (message.error) reject(Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error(`Timed out: ${expression}`);
}
async function click(expression) {
  await evaluate(`${expression}.scrollIntoView({block:'center'})`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Some forwarded Chrome sessions acknowledge Input.dispatchMouseEvent but
  // deliver no events. This is a DOM-driven integration check, not evidence of
  // native pointer/clipboard behavior (covered by the standalone browser suite).
  await evaluate(`(()=>{const e=${expression};const r=e.getBoundingClientRect();
    const options={bubbles:true,composed:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2,button:0,pointerId:1,pointerType:'mouse'};
    e.dispatchEvent(new PointerEvent('pointerdown',{...options,buttons:1}));
    e.dispatchEvent(new MouseEvent('mousedown',{...options,buttons:1}));
    e.dispatchEvent(new PointerEvent('pointerup',{...options,buttons:0}));
    e.dispatchEvent(new MouseEvent('mouseup',{...options,buttons:0}));
    e.click();e.focus();})()`);
}
const select = (label, value) =>
  evaluate(
    `(()=>{const e=document.querySelector('select[aria-label=${JSON.stringify(label)}]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
const button = (label) =>
  `Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(label)})`;
let appearance;
try {
  const url = new URL(chat);
  url.searchParams.set("git-hash", commit);
  await send("Page.navigate", { url: url.href });
  await send("Page.bringToFront");
  await until(`!!document.querySelector('select[aria-label="Diff renderer"]')`);
  appearance = await evaluate(
    `document.querySelector('select[aria-label="Appearance"]').value`,
  );
  await select("Diff renderer", "pierre");
  await until(
    `!!document.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-gutter] [data-line-number-content]')`,
  );
  await click(
    `document.querySelector('diffs-container').shadowRoot.querySelector('[data-column-number="10"]')`,
  );
  await until(`!${button("Add inline comment")}.disabled`);
  await click(button("Add inline comment"));
  const editor = `document.querySelector('[aria-label="Active inline comment"] [contenteditable="true"]')`;
  await until(`!!${editor}`);
  await click(editor);
  await evaluate(
    `(()=>{const range=document.createRange();range.selectNodeContents(${editor});range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()`,
  );
  await evaluate(
    `document.execCommand('insertText',false,'Pierre live retained draft')`,
  );
  await evaluate(`void (window.__reviewEditor = ${editor})`);
  await evaluate(
    `document.querySelector('[aria-label="Git diff"]').scrollTop = 10000`,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await select("Appearance", "dark");
  await until(
    `document.querySelector('diffs-container')?.shadowRoot?.querySelector('pre') && getComputedStyle(document.querySelector('diffs-container').shadowRoot.querySelector('pre')).backgroundColor === 'rgb(36, 41, 46)'`,
  );
  assert.equal(await evaluate(`${editor} === window.__reviewEditor`), true);
  assert.match(
    await evaluate(`${editor}.textContent`),
    /Pierre live retained draft/,
  );
  await select("Appearance", "light");
  await until(
    `document.querySelector('diffs-container')?.shadowRoot?.querySelector('pre') && getComputedStyle(document.querySelector('diffs-container').shadowRoot.querySelector('pre')).backgroundColor === 'rgb(255, 255, 255)'`,
  );
  await evaluate(
    `document.querySelector('[aria-label="Git diff"]').scrollTop = 0`,
  );
  assert.equal(await evaluate(`${editor} === window.__reviewEditor`), true);
  await click(
    `Array.from(document.querySelectorAll('[aria-label="Active inline comment"] button')).find(e => e.textContent.trim() === 'Cancel')`,
  );
  await until(
    `!document.querySelector('[aria-label="Active inline comment"]')`,
  );
  console.log(
    "PASS: live Pierre gutter selection, real Slate editor retained through virtualization and Light/Dark changes, draft cancelled without saving.",
  );
} finally {
  if (appearance) await select("Appearance", appearance);
  socket.close();
  await fetch(`${endpoint}/json/close/${target.id}`);
}
