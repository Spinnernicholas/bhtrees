const frame = document.querySelector('iframe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function until(predicate, message) {
  for (let i = 0; i < 2500; i++) { if (predicate()) return; await sleep(20); }
  throw new Error(message);
}
try {
  await until(() => frame.contentDocument?.querySelector('#history li'), 'Application did not initialize');
  const doc = frame.contentDocument;
  check(frame.contentWindow.getComputedStyle(doc.body).maxWidth === '1120px', 'Stylesheet did not load');
  const get = id => doc.getElementById(id);
  const click = id => get(id).click();
  const inspection = () => JSON.parse(get('inspection').textContent);
  click('step'); check(inspection().paused, 'Step did not pause');
  click('start'); click('pause'); click('signal');
  await until(() => inspection().queuedResumes === 1, 'Paused event was not queued');
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
  click('step'); check(inspection().paused, 'Step resumed automatic execution');
  click('continue');
  await until(() => inspection().status === 'SUCCESS', 'Agent did not complete mission');
  check(inspection().output.delivered === 3, 'Agent did not deliver three crystals');
  check(doc.querySelectorAll('.crystal:not([hidden])').length === 0, 'Collected crystals still visible');
  const blocks = doc.querySelector('[data-node-id="trip-1"] > .node-children').children;
  for (let i = 1; i < blocks.length; i++) {
    check(Math.abs(blocks[i].getBoundingClientRect().top - blocks[i - 1].getBoundingClientRect().bottom) <= 1.5, 'Sibling blocks do not touch');
  }
  click('start'); click('start'); click('cancel');
  check(inspection().status === 'cancelled', 'Cancel failed');
  check(get('resources').textContent.includes('Active timers: 0 · Signal listeners: 0'), 'Restart or cancel leaked');
  document.body.dataset.result = 'pass';
  document.getElementById('result').textContent = 'PASS: controls, signal/timer races, polling, all, restart and cleanup';
} catch (error) {
  document.body.dataset.result = 'fail';
  document.getElementById('result').textContent = error.stack;
}
