const frame = document.querySelector('iframe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function until(predicate, message) {
  for (let i = 0; i < 2500; i++) { if (predicate()) return; await sleep(20); }
  throw new Error(message);
}
try {
  const { inverter, condition, createRunner, action, sequence, subtree, parallel, RUNNING, SUCCESS } = await import('../../dist/index.js');
  const { mountTreeView } = await import('./tree-view.js');
  const target = document.createElement('ol');
  const tree = inverter({ id: 'inverted', child: condition({ id: 'predicate', test: () => false }) });
  const view = mountTreeView({ target, tree });
  for (const mode of ['list', 'blocks']) {
    view.setMode(mode);
    view.update(createRunner(tree).tick());
    check(target.querySelector('[data-node-id="inverted"] .node-children [data-node-id="predicate"]'),
      'Decorator child is missing from the tree view');
    check(target.querySelector('.node-end').textContent === 'end inverter', 'Incorrect decorator label');
    check(target.querySelector('.node-status').textContent === 'SUCCESS', 'Incorrect decorator result');
  }
  view.dispose();
  check(target.children.length === 0, 'Decorator view did not dispose');
  const shared = action({ id: 'shared-leaf', tick: () => RUNNING });
  const calls = sequence({ id: 'calls', steps: [
    { node: subtree({ id: 'first-call', child: shared }) },
    { node: subtree({ id: 'second-call', child: shared }) }
  ] });
  const callView = mountTreeView({ target, tree: calls });
  callView.update(createRunner(calls).tick());
  check(target.querySelector('[data-node-id="first-call"] [data-node-id="shared-leaf"]').classList.contains('active'),
    'Active subtree occurrence was not matched');
  check(!target.querySelector('[data-node-id="second-call"] [data-node-id="shared-leaf"]').classList.contains('active'),
    'Inactive shared definition occurrence was marked active');
  callView.dispose();
  const sharedBranch = action({ id: 'shared-branch', tick: c => c.input ? SUCCESS : RUNNING });
  const parallelTree = parallel({ id: 'parallel', successThreshold: 2, failureThreshold: 1, steps: [
    { node: sharedBranch, input: () => false }, { node: sharedBranch, input: () => true }
  ] });
  const parallelView = mountTreeView({ target, tree: parallelTree });
  const parallelRunner = createRunner(parallelTree);
  parallelView.update(parallelRunner.tick());
  const branchRows = target.querySelectorAll('[data-node-id="shared-branch"]');
  check(branchRows[0].classList.contains('active') && !branchRows[1].classList.contains('active'),
    'Parallel rows must distinguish repeated definitions by child position');
  parallelRunner.cancel(); parallelView.dispose();
  await until(() => frame.contentDocument?.querySelector('#history li'), 'Application did not initialize');
  const doc = frame.contentDocument;
  check(frame.contentWindow.getComputedStyle(doc.querySelector('.playground')).display === 'grid', 'Stylesheet did not load');
  for (const [width, height] of [[1366, 768], [1024, 600], [390, 844]]) {
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    await sleep(50);
    for (const selector of ['.controls', '#world', '#tree', '#resources']) {
      const rect = doc.querySelector(selector).getBoundingClientRect();
      check(rect.top >= 0 && rect.bottom <= height && rect.left >= 0 && rect.right <= width && rect.height > 0,
        `${selector} is outside the ${width}×${height} viewport`);
    }
    const tree = doc.getElementById('tree');
    tree.scrollTop = 200;
    check(tree.scrollTop > 0, 'Tree should scroll independently');
    tree.scrollTop = 0;
  }
  const get = id => doc.getElementById(id);
  const click = id => get(id).click();
  const inspection = () => JSON.parse(get('inspection').textContent);
  click('step'); check(inspection().paused, 'Step did not pause');
  click('reset');
  check(inspection().status === 'idle' && !inspection().paused, 'Reset did not return to idle');
  await sleep(300);
  check(inspection().transitions === 0, 'Reset started execution');
  get('name').value = 'Smoke explorer';
  click('start');
  check(get('start').disabled, 'Start should be disabled during a run');
  await sleep(200);
  click('pause');
  const pausedSnapshot = get('inspection').textContent;
  const pausedWorld = get('world').innerHTML;
  const pausedResources = get('resources').textContent;
  check(get('signal').disabled, 'Radar should be disabled while paused');
  click('signal');
  await sleep(1500);
  check(get('inspection').textContent === pausedSnapshot, 'Execution changed while paused');
  check(get('world').innerHTML === pausedWorld, 'World changed while paused');
  check(get('resources').textContent === pausedResources, 'Timer expired while paused');
  check(get('tree').dataset.view === 'blocks', 'Blocks should be the default view');
  check(doc.querySelectorAll('#tree > .sequence > .node-children > .tree-node').length === 3, 'Blocks are not nested under sequence');
  const transitions = inspection().transitions;
  const node = doc.querySelector('[data-node-id="trip-1-scan"] > .node-header');
  node.click();
  check(JSON.parse(get('node-inspection').textContent).nodeId === 'trip-1-scan', 'Node selection failed');
  get('tree-mode').value = 'list';
  get('tree-mode').dispatchEvent(new frame.contentWindow.Event('change'));
  check(get('tree').dataset.view === 'list', 'List switch failed');
  check(node.getAttribute('aria-pressed') === 'true', 'Selection was lost');
  get('tree-mode').value = 'blocks';
  get('tree-mode').dispatchEvent(new frame.contentWindow.Event('change'));
  check(inspection().transitions === transitions && inspection().paused, 'View switching changed execution');
  check(inspection().status === 'RUNNING', 'Paused tree completed');
  click('continue');
  await sleep(300);
  check(inspection().frames.some(f => f.nodeId === 'trip-1-scan'), 'Scan timer did not preserve its remaining duration');
  click('signal');
  await until(() => get('game-status').textContent.startsWith('Travel to crystal'), 'Radar did not start travel');
  click('pause');
  const roverPosition = get('agent').getAttribute('style');
  await sleep(500);
  check(get('agent').getAttribute('style') === roverPosition, 'Rover moved while paused');
  click('continue');
  await until(() => inspection().status === 'SUCCESS', 'Agent did not complete mission');
  check(inspection().output.delivered === 3, 'Agent did not deliver three crystals');
  check(inspection().output.agent === 'Smoke explorer', 'Start did not use the entered name');
  check(doc.querySelectorAll('.crystal:not([hidden])').length === 0, 'Collected crystals still visible');
  const blocks = doc.querySelector('[data-node-id="trip-1"] > .node-children').children;
  for (let i = 1; i < blocks.length; i++) {
    check(Math.abs(blocks[i].getBoundingClientRect().top - blocks[i - 1].getBoundingClientRect().bottom) <= 1.5, 'Sibling blocks do not touch');
  }
  click('start');
  check(inspection().status === 'SUCCESS', 'Start reset a completed run');
  click('reset'); click('start'); click('reset');
  check(inspection().status === 'idle' && get('agent').style.left === '12%', 'Reset did not restore the world');
  check(inspection().frames.length === 0 && inspection().queuedResumes === 0, 'Reset leaked resources');
  click('start'); click('cancel');
  check(inspection().status === 'cancelled', 'Cancel failed');
  check(inspection().frames.length === 0 && inspection().queuedResumes === 0, 'Restart or cancel leaked');
  click('reset'); click('start'); click('pause');
  for (let count = 0; count < 1000 && inspection().status === 'RUNNING'; count++) {
    const before = inspection();
    click('step');
    const after = inspection();
    check(after.paused, 'Step resumed automatic execution');
    check(after.transitions === before.transitions + 1, 'Step must advance exactly one transition, including waits');
    const snapshot = get('inspection').textContent;
    const world = get('world').innerHTML;
    await sleep(20);
    check(get('inspection').textContent === snapshot && get('world').innerHTML === world,
      'Execution continued between debugger steps');
  }
  check(inspection().status === 'SUCCESS' && inspection().output.delivered === 3,
    'Stepping did not complete the mission');
  check(inspection().frames.length === 0 && inspection().queuedResumes === 0, 'Stepping leaked resources');
  document.body.dataset.result = 'pass';
  document.getElementById('result').textContent = 'PASS: layout, start/reset, frozen pause, resume, mission and cleanup';
} catch (error) {
  document.body.dataset.result = 'fail';
  document.getElementById('result').textContent = error.stack;
}
