import { createRunner, RUNNING } from '../../src/index.js';
import { mountTreeView } from './tree-view.js';
import { createWorld, advanceWorld, createMission } from './game.js';

const byId = id => document.getElementById(id);
const signal = byId('signal');
let runner, listenerCount = 0, lastSignature = '';
const timers = new Set();
function log(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  byId('history').prepend(item);
  while (byId('history').children.length > 100) byId('history').lastChild.remove();
}
const clock = {
  setTimeout(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id); return id;
  },
  clearTimeout(id) { clearTimeout(id); timers.delete(id); }
};
let world, tree, treeView, selectedNode;
const crystalElements = [];
function mountWorld() {
  byId('crystals').replaceChildren();
  crystalElements.length = 0;
  for (const crystal of world.crystals) {
    const marker = document.createElement('span');
    marker.className = 'crystal'; marker.textContent = crystal.id;
    marker.style.left = `${crystal.x}%`; marker.style.top = `${crystal.y}%`;
    byId('crystals').append(marker); crystalElements.push(marker);
  }
}
byId('tree-mode').onchange = event => treeView.setMode(event.target.value);
function render() {
  const state = runner.snapshot();
  const active = state.status === 'idle' || state.status === RUNNING;
  byId('status').textContent = `${state.status}${state.paused ? ' · paused' : ''}`;
  byId('pause').disabled = !active || state.paused;
  byId('continue').disabled = !active || !state.paused;
  byId('step').disabled = !active;
  byId('cancel').disabled = !active;
  signal.disabled = listenerCount === 0;
  treeView.update(state);
  byId('agent').style.left = `${world.x}%`;
  byId('agent').style.top = `${world.y}%`;
  world.crystals.forEach((crystal, index) => { crystalElements[index].hidden = !crystal.remaining; });
  byId('game-status').textContent = `${world.phase} · Cargo ${world.cargo} · Delivered ${world.delivered} / 3`;
  byId('node-inspection').textContent = JSON.stringify(
    state.frames.find(frame => frame.nodeId === selectedNode) ?? {
      nodeId: selectedNode, status: selectedNode === tree.id ? state.status : 'inactive',
      ...(selectedNode === tree.id ? { output: state.output } : {}),
      note: 'Only live activation data is retained in this example.'
    }, null, 2);
  byId('resources').textContent = `Active timers: ${timers.size} · Signal listeners: ${listenerCount}`;
  byId('inspection').textContent = JSON.stringify(state, (key, value) => value instanceof Error ? value.message : value, 2);
  const signature = JSON.stringify([state.status, state.paused, state.frames.map(f => [f.nodeId, f.phase]), state.queuedResumes]);
  if (signature !== lastSignature) { log(`${state.status}${state.paused ? ' (paused)' : ''} · ${state.frames.at(-1)?.nodeId ?? 'no active node'} · queued: ${state.queuedResumes}`); lastSignature = signature; }
}
function restart(run = true) {
  runner?.cancel('restart');
  treeView?.dispose();
  world = createWorld();
  const mission = createMission(world, emit => {
    const click = () => emit('radar ping');
    signal.addEventListener('click', click); listenerCount++;
    return () => { signal.removeEventListener('click', click); listenerCount--; };
  }, log);
  tree = mission.tree; selectedNode = tree.id;
  treeView = mountTreeView({ target: byId('tree'), tree, labels: mission.labels,
    onSelect(id) { selectedNode = id; render(); } });
  treeView.setMode(byId('tree-mode').value);
  mountWorld();
  runner = createRunner(tree, { input: { name: byId('name').value }, clock });
  lastSignature = ''; log('New run');
  if (run) runner.tick();
  render();
}
byId('start').onclick = () => restart();
for (const command of ['pause', 'continue', 'step', 'cancel']) {
  byId(command).onclick = () => { runner[command](); log(command); render(); };
}
restart(false);
let previousTime = performance.now();
const loop = setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min((now - previousTime) / 1000, 0.2);
  previousTime = now;
  const state = runner.snapshot();
  if (!state.paused && state.status === RUNNING) { advanceWorld(world, elapsed); runner.tick(); }
  render();
}, 100);
addEventListener('pagehide', () => { clearInterval(loop); runner.cancel('page closed'); treeView.dispose(); }, { once: true });
