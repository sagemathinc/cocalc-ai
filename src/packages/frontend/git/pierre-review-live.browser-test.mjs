// Real application/Slate smoke test through an isolated Chrome target. The raw
// page CDP connection avoids attaching to every preexisting maintainer tab.
// Usage: node .../pierre-review-live.browser-test.mjs <chat-url> <commit>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [chat, commit] = process.argv.slice(2);
const historyWorktree = process.argv[4];
const historyRef = process.env.REVIEW_HISTORY_REF;
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
  if (process.env.REVIEW_COMPARE) {
    const beforeKeys = await evaluate(`Object.keys(localStorage)`);
    await click(button("Compare revisions..."));
    await until(`!!document.querySelector('[aria-label="Compare revisions"]')`);
    await evaluate(
      `(()=>{const section=document.querySelector('[aria-label="Compare revisions"]');const select=section.querySelector('select');select.value='trees';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await evaluate(
      `(()=>{const section=document.querySelector('[aria-label="Compare revisions"]');for(const label of section.querySelectorAll('label')) {const input=label.querySelector('input');if(!input)continue;const value=label.textContent.includes('Base ref')?${JSON.stringify(process.env.REVIEW_COMPARE_BASE ?? commit)}:${JSON.stringify(commit)};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}})()`,
    );
    await click(button("Compare / Refresh"));
    await until(
      `!!document.querySelector('[aria-label="Comparison review note"]') && !document.querySelector('[aria-label="Comparison review note"]').disabled`,
    );
    const pinnedRoute = await evaluate(
      `new URL(location.href).searchParams.get('git-compare')`,
    );
    assert.equal(JSON.parse(pinnedRoute).mode, "trees");
    assert.equal(JSON.parse(pinnedRoute).head, commit);
    assert.equal(
      JSON.parse(pinnedRoute).base,
      process.env.REVIEW_COMPARE_BASE ?? commit,
    );
    const oldTimeOrigin = await evaluate("performance.timeOrigin");
    await send("Page.reload");
    await until(`performance.timeOrigin !== ${JSON.stringify(oldTimeOrigin)}`);
    await until(
      `!!document.querySelector('[aria-label="Comparison review note"]') && !document.querySelector('[aria-label="Comparison review note"]').disabled`,
    );
    assert.deepEqual(
      JSON.parse(
        await evaluate(
          `new URL(location.href).searchParams.get('git-compare')`,
        ),
      ),
      JSON.parse(pinnedRoute),
    );
    if (process.env.REVIEW_COMPARE_BASE) {
      await until(
        `!!document.querySelector('[aria-label="Comparison review"] diffs-container')`,
      );
      await evaluate(
        `document.querySelector('[aria-label="Comparison review"]').dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))`,
      );
      assert.equal(
        await evaluate(
          `document.activeElement?.closest('label')?.textContent.trim()`,
        ),
        "Search loaded diff",
      );
      await evaluate(
        `(()=>{const input=document.activeElement;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'+');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await until(
        `/1 of [1-9][0-9]* matches/.test(document.querySelector('[aria-label="Comparison review"]').innerText)`,
      );
      await click(button("Next match"));
    } else
      await until(
        `document.querySelector('[aria-label="Comparison review"]').innerText.includes('No changes between these pinned endpoints')`,
      );
    await evaluate(
      `(()=>{const input=document.querySelector('[aria-label="Comparison review note"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Comparison local draft smoke');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await until(`!!${button("Keep local draft and close")}`);
    await click(button("Keep local draft and close"));
    await until(`!document.querySelector('[aria-label="Comparison review"]')`);
    assert.equal(
      await evaluate(`new URL(location.href).searchParams.has('git-compare')`),
      false,
    );
    await evaluate(
      `(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('cocalc:git-target-draft:v1:')&&!${JSON.stringify(beforeKeys)}.includes(key))localStorage.removeItem(key);})()`,
    );
    console.log(
      "PASS: live comparison controls, pinned trees, account review loading, optional diff search, and local-draft close without remote review writes.",
    );
  } else if (historyRef) {
    await until(`!!document.querySelector('select[aria-label="History ref"]')`);
    await select("History ref", historyRef);
    assert.equal(
      await evaluate(`new URL(location.href).searchParams.get('git-hash')`),
      commit,
    );
    await click(button("Browse / Refresh"));
    await until(
      `new URL(location.href).searchParams.get('git-ref') === ${JSON.stringify(historyRef)}`,
    );
    const route = await evaluate(`location.href`);
    const tip = new URL(route).searchParams.get("git-tip");
    assert.match(tip, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    assert.equal(new URL(route).searchParams.get("git-hash"), tip);
    await send("Page.reload");
    await until(
      `document.querySelector('select[aria-label="History ref"]')?.value === ${JSON.stringify(historyRef)}`,
    );
    assert.equal(await evaluate(`location.href`), route);
    console.log(
      "PASS: explicit ref browsing pins history and restores its context on reload.",
    );
  } else if (historyWorktree) {
    const git = (...args) =>
      execFileSync("git", ["-C", historyWorktree, ...args], {
        encoding: "utf8",
      });
    const expected = git("rev-parse", "HEAD").trim();
    const before = git("status", "--porcelain=v1");
    await until(
      `!!document.querySelector('select[aria-label="Review working copy"]')`,
    );
    assert.equal(
      await evaluate(
        `Array.from(document.querySelector('select[aria-label="Review working copy"]').options).some(option => option.value === ${JSON.stringify(historyWorktree)})`,
      ),
      true,
      "The browser project must contain the supplied local worktree; a different project can have a separate checkout.",
    );
    await select("Review working copy", historyWorktree);
    await select("History ref", "HEAD");
    assert.equal(
      await evaluate(`new URL(location.href).searchParams.get('git-hash')`),
      commit,
    );
    await click(button("Browse / Refresh"));
    await until(
      `new URL(location.href).searchParams.get('git-hash') === ${JSON.stringify(expected)}`,
    );
    await until(
      `document.querySelector('select[aria-label="Review working copy"]').value === ${JSON.stringify(historyWorktree)}`,
    );
    assert.equal(
      await evaluate(`new URL(location.href).searchParams.get('git-cwd')`),
      historyWorktree,
    );
    await send("Page.reload");
    await until(
      `document.querySelector('select[aria-label="Review working copy"]')?.value === ${JSON.stringify(historyWorktree)}`,
    );
    assert.equal(
      await evaluate(`new URL(location.href).searchParams.get('git-hash')`),
      expected,
    );
    assert.equal(git("rev-parse", "HEAD").trim(), expected);
    assert.equal(git("status", "--porcelain=v1"), before);
    console.log(
      "PASS: explicit live worktree browsing pins the selected HEAD without checkout or working-copy changes.",
    );
  } else {
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
  }
} catch (error) {
  console.error(
    await evaluate(
      `JSON.stringify({url:location.href,error:document.querySelector('[aria-label="Repository history"] .ant-alert')?.innerText})`,
    ),
  );
  throw error;
} finally {
  if (appearance) await select("Appearance", appearance);
  socket.close();
  await fetch(`${endpoint}/json/close/${target.id}`);
}
