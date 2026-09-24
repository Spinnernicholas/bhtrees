import { action, sequence, createRunner } from '../src/index.js';

const tree = sequence({ id: 'greeting', steps: [
  { node: action({ id: 'name', enter: ctx => ctx.success(ctx.input.name) }), save: 'name' },
  { node: action({ id: 'greet', enter: ctx => ctx.success(`Hello, ${ctx.input}!`) }),
    input: scope => scope.vars.name }
] });

console.log(createRunner(tree, { input: { name: 'Adventure Land' } }).tick().output);
