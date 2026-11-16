// Records the computed styles of every element in the mock app (css-check.html), so a CSS change
// can be proven to alter nothing on screen. Usage and setup: docs/CSS_ARCHITECTURE.md,
// "Checking a CSS change".
//
//   node scripts/css-check/dump.mjs <out.json>
//
// Needs the Vite dev server and a headless Chrome with remote debugging already running.
// Optional env: WIDTHS, THEMES, SCENARIOS (comma separated), CHROME_PORT, CSS_CHECK_URL.
import { writeFileSync } from "node:fs";
import { PROPS } from "./props.mjs";
if (!process.argv[2]) { console.error("usage: node scripts/css-check/dump.mjs <out.json>"); process.exit(2); }
const PORT = process.env.CHROME_PORT || 9444;
const BASE = process.env.CSS_CHECK_URL || "http://localhost:1437/scripts/css-check/css-check.html";
const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
const page = list.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DUMP = `(() => { const P=${JSON.stringify(PROPS)}; const out={};
  const key=(e)=>{const parts=[];while(e&&e!==document.documentElement){const p=e.parentElement;const i=p?[...p.children].indexOf(e):0;parts.unshift(e.tagName.toLowerCase()+(typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\\s+/).join('.'):'')+':'+i);e=p;}return parts.slice(-4).join('>')+'#'+parts.length;};
  const all=[...document.body.querySelectorAll('*')]; const seen={};
  for(const e of all){ if(['SCRIPT','STYLE'].includes(e.tagName)) continue; let k=key(e); seen[k]=(seen[k]||0)+1; k+='~'+seen[k];
    const take=(cs)=>P.map(p=>cs.getPropertyValue(p)).join('|');
    out[k]=take(getComputedStyle(e));
    if(e.hasAttribute('data-tooltip')) out[k+'::after']=take(getComputedStyle(e,'::after'));
    if(e.tagName==='BUTTON'||e.tagName==='SVG') out[k+'::before']=take(getComputedStyle(e,'::before'));
  } return out; })()`;
await send("Page.enable"); await send("DOM.enable"); await send("CSS.enable"); await send("Runtime.enable");
const WIDTHS = process.env.WIDTHS ? process.env.WIDTHS.split(",").map(Number) : [360, 400, 480, 600, 640, 720, 768, 860, 861, 1180, 1220, 1400];
const THEMES = (process.env.THEMES || "dark,light").split(",");
const result = {};
const SCENARIOS = (process.env.SCENARIOS || "full,empty,icons").split(",");
for (const scenario of SCENARIOS) for (const theme of THEMES) for (const width of WIDTHS) {
  if (theme === "light" && ![400, 861, 1400].includes(width) && !process.env.WIDTHS) continue;
  if (scenario !== "full" && (theme !== "dark" || ![400, 1400].includes(width))) continue;
  const touch = width <= 860;
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: touch });
  await send("Emulation.setTouchEmulationEnabled", { enabled: touch });
  await send("Page.navigate", { url: `${BASE}?theme=${theme}&scenario=${scenario}` });
  for (let i = 0; i < 60; i++) { await sleep(150); if (await evaluate("!!document.querySelector('.provider-account-card, .welcome-panel, .dashboard-header')")) break; }
  await sleep(400);
  for (const pageName of ["Dashboard", "Usage", "Settings"]) {
    const clicked = await evaluate(`(() => { const b=[...document.querySelectorAll('.bottom-nav-item, .top-bar-nav-item')].find(b=>b.textContent.trim()===${JSON.stringify(pageName)}); if(!b) return false; b.click(); return true; })()`);
    await sleep(500);
    const tag = `${scenario}/${theme}/${width}/${pageName}${clicked ? "" : "(no nav)"}`;
    result[tag] = await evaluate(DUMP);
    const { result: doc } = await send("DOM.getDocument", { depth: 0 });
    const { result: q } = await send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "button, [data-tooltip], input, select, a, summary, [role=button], [tabindex]" });
    for (const state of ["hover", "focus-visible", "active"]) {
      for (const nodeId of q.nodeIds) await send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: state === "focus-visible" ? ["focus", "focus-visible"] : [state] });
      result[`${tag}:${state}`] = await evaluate(DUMP);
    }
    for (const nodeId of q.nodeIds) await send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    // menus: open the first card menu, dump, close
    const opened = await evaluate(`(() => { const b=document.querySelector('.mobile-dropdown-toggle, .account-card-action.more-action'); if(!b||b.offsetParent===null) return false; b.click(); return true; })()`);
    if (opened) { await sleep(250); result[`${tag}+menu`] = await evaluate(DUMP); await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(150); }
  }
  console.error(theme, width, Object.keys(result).length);
}
writeFileSync(process.argv[2], JSON.stringify(result));
ws.close();
