// Real application save-conflict test. Requires an initially empty private
// note; preserves other review fields and removes its test note on success.
import assert from "node:assert/strict";
const [chat, hash] = process.argv.slice(2);
if (!chat || !/^[a-f0-9]{40,64}$/.test(hash ?? ""))
  throw Error("Supply chat URL and full commit hash");
const endpoint = process.env.CDP_URL ?? "http://localhost:9222";
const pages = [];
async function open() {
  const target = await (
    await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(Error(`Timeout ${method}`));
      }, 15000);
      pending.set(n, (message) => {
        clearTimeout(timer);
        pending.delete(n);
        message.error
          ? reject(Error(JSON.stringify(message.error)))
          : resolve(message.result);
      });
      socket.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 120; i++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const page = { target, socket, send, evaluate, until };
  pages.push(page);
  const url = new URL(chat);
  url.searchParams.set("git-hash", hash);
  await send("Page.navigate", { url: url.href });
  await until(
    `document.body.innerText.includes(${JSON.stringify(process.env.REVIEW_CLEANUP ? "CoCalc concurrency smoke:" : "No private review note yet.")}) && !document.body.innerText.includes('Loading review state...')`,
  );
  return page;
}
const button = (text) =>
  `Array.from(document.querySelectorAll('.ant-drawer-body button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
async function click(page, text) {
  await page.until(`!!${button(text)} && !${button(text)}.disabled`);
  await page.evaluate(`${button(text)}.click()`);
}
async function edit(page, text) {
  await click(page, "Edit");
  await page.until(`!!${button("Save note")}`);
  await page.evaluate(`(()=>{
    const root=${button("Save note")}.parentElement.parentElement;
    const element=root.querySelector('[contenteditable="true"]');
    if(!element)throw Error('Review note editor missing');
    let fiber=element[Object.keys(element).find(k=>k.startsWith('__reactFiber'))];
    while(fiber && !fiber.memoizedProps?.editor?.insertText)fiber=fiber.return;
    if(!fiber)throw Error('Slate instance missing');
    const slate=window.__raceSlate=fiber.memoizedProps.editor;
    function last(node,path=[]){if(typeof node.text==='string')return {path,offset:node.text.length};const i=node.children.length-1;return last(node.children[i],[...path,i]);}
    slate.select({anchor:{path:[0,0],offset:0},focus:last(slate)});
    if (${JSON.stringify(text)} === '') slate.deleteFragment();
    else slate.insertText(${JSON.stringify(text)});
  })()`);
}
let saved = false;
try {
  const first = await open();
  if (process.env.REVIEW_CLEANUP) {
    await edit(first, "");
    await click(first, "Save note");
    await first.until(
      `!${button("Save note")} && document.body.innerText.includes('No private review note yet.')`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await first.send("Page.reload", {});
    await first.until(
      `document.body.innerText.includes('No private review note yet.')`,
    );
    console.log("PASS: test note cleared and empty state verified on reload.");
  } else {
    const second = await open();
    await edit(first, "CoCalc concurrency smoke: first window");
    await click(first, "Save note");
    await first.until(
      `!${button("Save note")} && document.body.innerText.includes('CoCalc concurrency smoke: first window')`,
    );
    saved = true;
    await edit(second, "CoCalc concurrency smoke: second window");
    await click(second, "Save note");
    await second.until(
      `document.body.innerText.includes('another window may have changed it')`,
    );
    assert.match(
      await second.evaluate(`JSON.stringify(window.__raceSlate.children)`),
      /second window/,
    );
    await click(second, "Cancel");
    // First still owns the latest successful sequence and can restore the empty
    // note. A concurrent third writer causes a conflict rather than being erased.
    await edit(first, "");
    await click(first, "Save note");
    await first.until(
      `!${button("Save note")} && document.body.innerText.includes('No private review note yet.')`,
    );
    saved = false;
    await first.send("Page.reload", {});
    await first.until(
      `document.body.innerText.includes('No private review note yet.')`,
    );
    console.log(
      "PASS: first save succeeded, stale second save rejected with Slate draft retained, original empty note restored and verified after reload.",
    );
  }
} finally {
  if (saved)
    console.error(
      "Test note may remain: inspect the specified commit's private note before rerunning.",
    );
  for (const page of pages) {
    page.socket.close();
    await fetch(`${endpoint}/json/close/${page.target.id}`);
  }
}
