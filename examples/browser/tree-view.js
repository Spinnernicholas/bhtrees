/** Snapshot-driven view: presentation never changes runner execution. */
export function mountTreeView({ target, tree, labels = {}, onSelect = () => {} }) {
  const document = target.ownerDocument;
  const rows = [];
  let selected = tree.id;
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function build(definition, binding, ancestors = []) {
    const path = [...ancestors, definition.id];
    const row = element('li', `tree-node ${definition.type}`);
    row.dataset.nodeId = definition.id;
    const header = element('button', 'node-header');
    header.type = 'button';
    const title = element('span', 'node-title');
    title.append(element('span', 'node-kind', definition.type),
      element('strong', 'node-label', labels[definition.id] ?? definition.id));
    const status = element('span', 'node-status', 'inactive');
    header.append(title, status);
    const select = () => { selected = definition.id; markSelection(); onSelect(definition.id); };
    header.addEventListener('click', select);
    row.append(header);
    const meta = element('div', 'node-meta', definition.id);
    meta.append(element('span', 'node-port', `reactive: ${definition.reactive ?? 'inherited'}`));
    if (binding?.save) meta.append(element('span', 'node-port', `output → ${binding.save}`));
    row.append(meta);
    const steps = definition.steps ?? (definition.child ? [{ node: definition.child }] : undefined);
    if (steps) {
      const children = element('ol', 'node-children');
      for (const step of steps) children.append(build(step.node, step, path));
      row.append(children, element('div', 'node-end', `end ${definition.type}`));
    }
    rows.push({ definition, row, header, status, select, path });
    return row;
  }
  target.replaceChildren(build(tree));
  function markSelection() {
    for (const { definition, row, header } of rows) {
      const active = selected === definition.id;
      row.classList.toggle('selected', active);
      header.setAttribute('aria-pressed', String(active));
    }
  }
  markSelection();
  return {
    setMode(mode) {
      if (!['list', 'blocks'].includes(mode)) throw new TypeError('Unknown tree view');
      target.dataset.view = mode;
    },
    update(snapshot) {
      for (const { definition, row, status, path } of rows) {
        let frame, parentActivationId = null;
        for (const nodeId of path) {
          frame = snapshot.frames.find(item => item.nodeId === nodeId && item.parentActivationId === parentActivationId);
          if (!frame) break;
          parentActivationId = frame.activationId;
        }
        row.classList.toggle('active', !!frame);
        status.textContent = frame
          ? `${frame.phase === 'running' ? 'RUNNING' : frame.phase}${frame.waitingOn ? ` · ${frame.waitingOn}` : ''}`
          : definition === tree ? snapshot.status : 'inactive';
      }
    },
    dispose() {
      for (const { header, select } of rows) header.removeEventListener('click', select);
      target.replaceChildren();
    }
  };
}
