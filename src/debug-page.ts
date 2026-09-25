export const debugPage = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>BHTrees remote debugger</title>
<style>body{font:16px system-ui;margin:2rem;background:#15202b;color:#eee}button{margin:.25rem;padding:.5rem}main{display:grid;grid-template-columns:1fr 1fr;gap:2rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:.5rem 0}button.active{border:2px solid #5fd}#connection{color:#5fd}@media(max-width:700px){main{display:block}}</style>
<h1>BHTrees remote debugger</h1><p id="connection" role="status">Connecting…</p>
<nav aria-label="Execution controls" id="controls"></nav><p id="status"></p>
<main><section><h2>Tree</h2><ul id="tree"></ul></section><section><h2>Inspection</h2><pre id="inspection"></pre></section></main>
<section><h2>Execution events</h2><label>Filter by node <input id="event-filter"></label><p id="event-count"></p><pre id="events"></pre></section>
<script type="module" src="/view.js"></script></html>`;

export const debugView = `import { createRemoteDebugger } from '/client.js';
const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
history.replaceState(null, '', location.pathname);
const client = createRemoteDebugger({ url: location.href, token });
const byId = id => document.getElementById(id);
let stopped = false, busy = false, selected = null, timer, lastRevision = -1;
const names = { pause: 'Pause', continue: 'Continue', stepInto: 'Step into', tick: 'Tick', cancel: 'Cancel' };
async function command(command) {
  if (busy) return;
  busy = true;
  try {
    const response = await client.command(command);
    if (!response.result.ok) throw Error(response.result.message);
    await refresh();
  } catch (error) { byId('connection').textContent = error.message; }
  finally { busy = false; }
}
function render(state) {
  const snapshot = state.snapshot, runner = snapshot.runner;
  if (snapshot.revision < lastRevision) return;
  lastRevision = snapshot.revision;
  byId('connection').textContent = 'Connected';
  byId('status').textContent = runner.status + (runner.paused ? ' · paused' : '') + ' · revision ' + snapshot.revision;
  byId('controls').replaceChildren();
  for (const [type, label] of Object.entries(names)) {
    if (!state.capabilities.includes(type)) continue;
    const button = document.createElement('button'); button.textContent = label;
    button.dataset.command = type;
    button.disabled = !['idle', 'RUNNING'].includes(runner.status) || type === 'tick' && runner.paused;
    button.onclick = () => command({ type }); byId('controls').append(button);
  }
  const nodes = new Map(state.definition.nodes.map(node => [node.id, node]));
  const live = Array.isArray(runner.frames) ? runner.frames : [];
  let count = 0;
  function branch(id, path, depth) {
    const item = document.createElement('li');
    if (++count > 2000 || depth > 64 || path.has(id)) { item.textContent = id + ' (tree display limit/reference)'; return item; }
    const node = nodes.get(id); if (!node) { item.textContent = id; return item; }
    const frames = live.filter(frame => frame.nodeId === id);
    const button = document.createElement('button'); button.textContent = node.id + ' · ' + node.type + ' · ' + (frames.map(f => f.phase).join(', ') || (id === state.definition.root ? runner.status : 'inactive'));
    button.className = frames.length ? 'active' : '';
    button.onclick = () => { selected = id; render(state); };
    item.append(button);
    const children = document.createElement('ul');
    for (const child of node.children) { if (count >= 2000) break; children.append(branch(child, new Set([...path, id]), depth + 1)); }
    if (children.children.length) item.append(children); return item;
  }
  byId('tree').replaceChildren(branch(state.definition.root, new Set(), 0));
  byId('inspection').textContent = JSON.stringify(selected ? { definition: nodes.get(selected), activations: live.filter(frame => frame.nodeId === selected) } : runner, null, 2);
  const filter = byId('event-filter').value;
  byId('event-count').textContent = state.events.length + ' retained; ' + state.droppedEvents + ' older events dropped';
  byId('events').textContent = state.events.filter(event => event.nodeId.includes(filter)).map(event =>
    '#' + event.sequence + ' tick ' + event.tick + ' transition ' + event.transition + ' · ' + event.nodeId +
    ' [' + (event.activationId ?? '-') + '] · ' + event.type + ' · ' + (event.phase ?? '-') + ' → ' + event.status +
    (event.reason ? ' · ' + event.reason : '')).join(String.fromCharCode(10));
  document.body.dataset.connected = 'true';
}
async function refresh() { const state = await client.read(); if (!stopped) render(state); }
async function poll() {
  try { if (!busy) await refresh(); }
  catch (error) { byId('connection').textContent = 'Disconnected: ' + error.message + ' — retrying'; document.body.dataset.connected = 'false'; }
  if (!stopped) timer = setTimeout(poll, 250);
}
addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); }, { once: true });
poll();`;
