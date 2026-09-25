import { action, sequence, createRegistry, encodeTree, decodeTree, createRunner } from '../dist/index.js';

const registry = createRegistry();
const greet = { tick: ctx => ctx.success(`Hello, ${ctx.input}!`) };
registry.registerAction('example.greet', greet);
const tree = sequence({ id: 'root', steps: [
  { node: action({ id: 'greet', ...greet }), input: { path: ['input', 'name'] } }
] });
for (const codec of ['json', 'yaml']) {
  const text = encodeTree(tree, { registry, codec });
  console.log(text);
  const loaded = decodeTree(text, { registry, codec });
  console.log(createRunner(loaded, { input: { name: 'portable trees' } }).tick().output);
}
