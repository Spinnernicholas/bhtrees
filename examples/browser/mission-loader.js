import { fromTreeDocument, parseYaml } from '../../dist/index.js';

// The example nests nodes for editing; the library's interchange format uses ID references.
export function loadMissionTree(text, registry, codec = 'json') {
  let source;
  if (codec === 'yaml') source = parseYaml(text);
  else if (codec === 'json') {
    try { source = JSON.parse(text); }
    catch (error) { throw new TypeError(`Invalid JSON: ${error.message}`); }
  } else throw new TypeError(`Unsupported mission format: ${codec}`);
  if (source?.format !== 'bhtrees-example' || source.version !== 1 || source.kind !== 'tree') {
    throw new TypeError('Expected a version 1 bhtrees-example tree');
  }
  for (const key of Object.keys(source)) {
    if (!['format', 'version', 'kind', 'root'].includes(key)) throw new TypeError(`Unknown mission field: ${key}`);
  }
  const nodes = [];
  const labels = Object.create(null);
  function visit(node, path, depth = 0) {
    if (depth > 128 || nodes.length >= 10000) throw new TypeError(`${path}: mission is too large`);
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new TypeError(`${path}: expected a node object`);
    if (node.label !== undefined && typeof node.label !== 'string') throw new TypeError(`${path}.label: expected text`);
    const { label, ...definition } = node;
    nodes.push(definition);
    labels[node.id] = label ?? node.id;
    if ((node.type === 'action' || node.type === 'condition') && definition.implementationVersion === undefined) {
      definition.implementationVersion = 1;
    }
    if (node.steps !== undefined) {
      if (!Array.isArray(node.steps)) throw new TypeError(`${path}.steps: expected an array`);
      definition.steps = node.steps.map((step, index) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) throw new TypeError(`${path}.steps[${index}]: expected a step`);
        return { ...step, node: visit(step.node, `${path}.steps[${index}].node`, depth + 1) };
      });
    }
    if (node.child !== undefined) definition.child = visit(node.child, `${path}.child`, depth + 1);
    return node.id;
  }
  const root = visit(source.root, '$.root');
  const tree = fromTreeDocument({ format: 'bhtrees', version: 1, kind: 'tree', root, nodes }, { registry });
  return { tree, labels };
}
