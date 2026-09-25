import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml, stringifyYaml, YamlError, DocumentError, createRegistry, action, sequence,
  encodeTree, decodeTree, toTreeDocument, createRunner, encodeValue, decodeValue, toPortableValue } from '../dist/index.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/yaml/profile.json', import.meta.url), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
// Extract the suite's literal fields without using the parser under test.
function upstreamField(source, field) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const start = lines.indexOf(`  ${field}: |`) + 1;
  assert.ok(start, `Missing upstream ${field}`);
  const content = [];
  for (let i = start; i < lines.length; i++) {
    if (lines[i] && !lines[i].startsWith('    ')) break;
    content.push(lines[i].slice(4));
  }
  return content.join('\n').replace(/\n*$/, '\n');
}
for (const [id, accepted] of [['229Q', true], ['236B', false], ['27NA', false], ['4CQQ', false]]) {
  test(`upstream YAML ${id}: ${accepted ? 'supported' : 'rejected by profile'}`, () => {
    const source = readFileSync(new URL(`./fixtures/yaml/upstream/${id}.yaml`, import.meta.url), 'utf8');
    const yaml = upstreamField(source, 'yaml');
    if (accepted) assert.deepEqual(plain(parseYaml(yaml)), JSON.parse(upstreamField(source, 'json')));
    else assert.throws(() => parseYaml(yaml), YamlError);
  });
}
for (const fixture of fixtures) test(`YAML profile: ${fixture.name}`, () => {
  if (fixture.error || fixture.reject) assert.throws(() => parseYaml(fixture.yaml), error =>
    error instanceof YamlError && (!fixture.error || (error.line === fixture.error[0] && error.column === fixture.error[1])));
  else {
    assert.deepEqual(plain(parseYaml(fixture.yaml)), fixture.value);
    assert.deepEqual(plain(parseYaml(stringifyYaml(fixture.value))), fixture.value);
  }
});

test('YAML writer quotes ambiguous strings and round trips all supported characters', () => {
  const values = ['true', 'null', '0x10', '', '---', '...', 'a: b', '# comment', '!tag', '&anchor', '*alias',
    '<<', 'line\nline\n', '\0\x07\x85\u2028\u2029\ufffe\uffff', '\ud800', '☃ 😀', '"quotes"', "don't"];
  for (let i = 0; i < 256; i++) values.push(String.fromCharCode(i));
  const document = { strings: values, nested: [{ a: [1, true, null, {}, []] }] };
  const text = stringifyYaml(document);
  assert.match(text, /"strings":\n/);
  assert.deepEqual(plain(parseYaml(text)), document);
  assert.deepEqual(plain(parseYaml('\uFEFF' + text.replaceAll('\n', '\r\n'))), document);
});

test('folded scalars preserve paragraph breaks, indentation and chomping', () => {
  assert.equal(parseYaml('>-\n  a\n\n\n  b\n'), 'a\n\nb');
  assert.equal(parseYaml('>-\n\n  a\n\n    code\n\n  b\n'), '\na\n\n  code\n\nb');
  assert.equal(parseYaml('|+\n  a\n    \n'), 'a\n  \n');
  assert.equal(parseYaml('|-\n\n'), '');
  assert.equal(parseYaml('|+\n\n'), '\n');
  assert.throws(() => parseYaml('|\n    \n  a\n'), /Leading blank/);
});

test('YAML writer rejects unsupported values without invoking getters', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const getter = Object.defineProperty({}, 'data', { enumerable: true, get() { throw Error('must not invoke'); } });
  for (const value of [undefined, () => {}, Symbol(), 1n, NaN, Infinity, -0, new Date(), cyclic, getter,
    [1, , 3], Object.assign([], { extra: 1 }), { [Symbol()]: 1 }]) {
    assert.throws(() => stringifyYaml(value), DocumentError);
  }
  const record = parseYaml('__proto__: safe\nconstructor: data');
  assert.equal(Object.getPrototypeOf(record), null);
  assert.equal(record.__proto__, 'safe');
});

test('YAML parser and writer enforce text, depth and value bounds', () => {
  assert.throws(() => parseYaml('x'.repeat(1000001)), YamlError);
  assert.throws(() => stringifyYaml('x'.repeat(1000001)), DocumentError);
  assert.throws(() => parseYaml('['.repeat(130) + '0' + ']'.repeat(130)), /depth/);
  let nested = null; for (let i = 0; i < 130; i++) nested = [nested];
  assert.throws(() => stringifyYaml(nested), /depth/);
  assert.throws(() => parseYaml('[' + '0,'.repeat(100000) + ']'), /size/);
  assert.throws(() => stringifyYaml(Array(100001).fill(0)), /size/);
  assert.throws(() => parseYaml('a: \x01'), error => error.line === 1 && error.column === 4);
  for (const text of ['...\na: 1', '--- inline', '... inline', '---\n---\na: 1']) assert.throws(() => parseYaml(text), YamlError);
});

test('JSON and YAML tree documents execute equivalently with shared custom nodes', () => {
  const registry = createRegistry();
  registry.registerNode('constant', { version: 1, create({ id, reactive, data }) {
    return action({ id, reactive, tick: c => c.success(data) });
  } });
  const child = registry.createNode('constant', { id: 'value', data: { result: 42 } });
  const root = sequence({ id: 'root', steps: [{ node: child }, { node: child }] });
  const yaml = encodeTree(root, { registry, codec: 'yaml' });
  const restored = decodeTree(yaml, { registry, codec: 'yaml' });
  assert.equal(restored.steps[0].node, restored.steps[1].node);
  assert.equal(createRunner(restored).tick().output.result, 42);
  assert.deepEqual(toTreeDocument(restored, { registry }), JSON.parse(encodeTree(root, { registry })));
  assert.throws(() => decodeTree(yaml), /JSON/);
  assert.throws(() => encodeTree(root, { codec: 'unknown' }), /Unsupported codec/);
  assert.throws(() => decodeTree('', { codec: 'unknown' }), /Unsupported codec/);
  assert.throws(() => decodeTree('format: bhtrees\nversion: 99\nkind: tree', { codec: 'yaml' }), error => error.path === '$.version');
});

test('YAML portable value codecs preserve envelopes, custom types and migrations', () => {
  const registry = createRegistry();
  registry.registerValue('date', { version: 2, test: v => v instanceof Date,
    encode: v => v.toISOString(), decode: v => new Date(v), migrations: { 1: v => new Date(v).toISOString() } });
  const value = { date: new Date(0), ordinary: { kind: 'custom', type: 'date' } };
  const text = encodeValue(value, { registry, codec: 'yaml' });
  assert.deepEqual(toPortableValue(decodeValue(text, { registry, codec: 'yaml' }), { registry }), toPortableValue(value, { registry }));
  assert.equal(decodeValue('kind: custom\ntype: date\nversion: 1\ndata: 0', { registry, codec: 'yaml' }).getTime(), 0);
  assert.throws(() => encodeValue(null, { codec: 'unknown' }), /Unsupported codec/);
  assert.throws(() => decodeValue('', { codec: 'unknown' }), /Unsupported codec/);
});
