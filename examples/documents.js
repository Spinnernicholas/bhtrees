import { action, sequence, createRegistry, encodeTree, decodeTree, createRunner } from '../dist/index.js';

const registry = createRegistry();
const greet = { tick: ctx => ctx.success(`Hello, ${ctx.input}!`) };
registry.registerAction('example.greet', greet);
const tree = sequence({ id: 'root', steps: [
  { node: action({ id: 'greet', ...greet }), input: { path: ['input', 'name'] } }
] });
const json = encodeTree(tree, { registry });
console.log(json);
const loaded = decodeTree(json, { registry });
console.log(createRunner(loaded, { input: { name: 'portable trees' } }).tick().output);
