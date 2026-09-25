import { DocumentError } from './document-error.js';

export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };
export class YamlError extends SyntaxError {
  constructor(public readonly line: number, public readonly column: number, message: string) {
    super(`${line}:${column}: ${message}`); this.name = 'YamlError';
  }
}
const MAX_TEXT = 1000000, MAX_DEPTH = 128, MAX_VALUES = 100000;
const space = (c: string | undefined) => c === undefined || /[ \t]/.test(c);
const empty = (text: string) => /^[ \t]*(?:#.*)?$/.test(text);

function scalar(text: string, fail: (message: string) => never): YamlValue {
  if (/^(?:null|Null|NULL|~)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[+-]?\.(?:inf|Inf|INF|nan|NaN|NAN)$/.test(text)) fail('Nonfinite numbers are unsupported');
  if (/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text) || /^(?:0x[0-9a-fA-F]+|0o[0-7]+)$/.test(text)) {
    const value = Number(text);
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('Number is not portable');
    return value;
  }
  return text;
}

/** A bounded YAML 1.2 application profile, not a full YAML implementation. */
export function parseYaml(text: string): YamlValue {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new YamlError(1, 1, 'Expected YAML text of at most 1000000 characters');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const finalBreak = /[\r\n]$/.test(text);
  if (lines.at(-1) === '') lines.pop();
  let row = 0, count = 0;
  const fail = (line: number, column: number, message: string): never => { throw new YamlError(line + 1, column + 1, message); };
  for (let i = 0; i < lines.length; i++) {
    const bad = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x84\x86-\x9f\ufffe\uffff]/.exec(lines[i]);
    if (bad) fail(i, bad.index, 'Invalid YAML character');
  }
  function check(depth: number, line: number, column: number) {
    if (depth > MAX_DEPTH || ++count > MAX_VALUES) fail(line, column, 'YAML depth or size limit exceeded');
  }
  function indent(line: number): number {
    const n = /^ */.exec(lines[line])![0].length;
    if (lines[line][n] === '\t') fail(line, n, 'Tabs cannot indent YAML');
    return n;
  }
  function skip() { while (row < lines.length && empty(lines[row])) row++; }
  function separator(source: string): number {
    if (source[0] === '[' || source[0] === '{') return -1;
    // Block keys can be plain or single-line quoted strings.
    let quote = source[0] === '"' || source[0] === "'" ? source[0] : '';
    for (let i = quote ? 1 : 0; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (quote === '"' && c === '\\') { i++; continue; }
        if (c === quote) {
          if (quote === "'" && source[i + 1] === "'") { i++; continue; }
          quote = '';
        }
      } else {
        if (c === '#' && (i === 0 || space(source[i - 1]))) break;
        if (c === ':' && space(source[i + 1])) return i;
      }
    }
    return -1;
  }
  function inline(source: string, line: number, column: number, depth: number): YamlValue {
    let pos = 0;
    const error = (message: string): never => fail(line, column + pos, message);
    function ws() { while (pos < source.length && /[ \t]/.test(source[pos])) pos++; }
    function quoted(): string {
      const quote = source[pos++]; let result = '';
      while (pos < source.length) {
        const c = source[pos++];
        if (c === quote) {
          if (quote === "'" && source[pos] === "'") { result += "'"; pos++; continue; }
          return result;
        }
        if (quote === '"' && c === '\\') {
          const escape = source[pos++];
          const escapes: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };
          if (Object.hasOwn(escapes, escape)) result += escapes[escape];
          else if (['x', 'u', 'U'].includes(escape)) {
            const size = escape === 'x' ? 2 : escape === 'u' ? 4 : 8;
            const digits = source.slice(pos, pos + size);
            if (digits.length !== size || !/^[0-9a-fA-F]+$/.test(digits)) error('Invalid Unicode escape');
            const code = parseInt(digits, 16);
            if (code > 0x10ffff) error('Invalid Unicode code point');
            result += String.fromCodePoint(code); pos += size;
          } else error('Unknown quoted escape');
        } else result += c;
      }
      return error('Unterminated quote; multiline quoted scalars are unsupported');
    }
    function value(level: number, flow: boolean, key = false): YamlValue {
      ws(); check(level, line, column + pos);
      const c = source[pos];
      if (c === '"' || c === "'") return quoted();
      if (c === '[' || c === '{') {
        if (key) error('Mapping keys must be strings');
        const mapping = c === '{', close = mapping ? '}' : ']'; pos++;
        const result: YamlValue[] | Record<string, YamlValue> = mapping ? Object.create(null) : [];
        ws();
        while (source[pos] !== close) {
          if (pos >= source.length || source[pos] === '#') error('Flow collections must close on the same line');
          if (mapping) {
            const quotedKey = source[pos] === '"' || source[pos] === "'";
            const name = value(level + 1, true, true); ws();
            if (typeof name !== 'string') return error('Mapping keys must be strings');
            if (source[pos] !== ':') error('Expected a mapping colon');
            if (!quotedKey && !space(source[pos + 1]) && ![',', '}', '[', '{'].includes(source[pos + 1])) error('Plain flow keys require separation after colon');
            pos++; ws();
            if (Object.hasOwn(result, name)) error('Duplicate mapping key');
            if ([',', '}'].includes(source[pos])) { check(level + 1, line, column + pos); (result as Record<string, YamlValue>)[name] = null; }
            else (result as Record<string, YamlValue>)[name] = value(level + 1, true);
          } else (result as YamlValue[]).push(value(level + 1, true));
          ws();
          if (source[pos] === close) break;
          if (source[pos++] !== ',') error('Expected a flow comma or closing delimiter');
          ws();
        }
        pos++; return result;
      }
      if (!c || ',]}'.includes(c)) return error('Expected a value');
      if ('!&*|>@`%'.includes(c) || (['-', '?', ':'].includes(c) && space(source[pos + 1]))) error('Unsupported YAML indicator (tags, anchors and aliases are not supported)');
      const start = pos;
      while (pos < source.length) {
        const char = source[pos];
        if (char === '#' && (pos === start || space(source[pos - 1]))) break;
        if (flow && ',[]{}'.includes(char)) break;
        if (char === ':' && (key || space(source[pos + 1]) || (flow && ',[]{}'.includes(source[pos + 1])))) break;
        pos++;
      }
      const word = source.slice(start, pos).trimEnd();
      if (!word) error('Expected a scalar');
      if (word === '---' || word === '...') error('Unexpected document marker');
      if (key && word === '<<') error('Merge keys are unsupported');
      return scalar(word, error);
    }
    const result = value(depth, false); ws();
    if (pos < source.length && !(source[pos] === '#' && pos > 0 && space(source[pos - 1]))) error('Unexpected content after value');
    return result;
  }
  function blockString(header: string, parent: number, line: number, column: number): string {
    const match = /^([|>])([+-]?)(?:[ \t]+#.*)?[ \t]*$/.exec(header);
    if (!match) fail(line, column, 'Unsupported block scalar header; explicit indentation indicators are not supported');
    const chunks: string[] = []; let contentIndent: number | undefined;
    const leadingBlanks: { row: number; spaces: number }[] = [];
    while (row < lines.length) {
      const raw = lines[row];
      if (/^ *$/.test(raw)) {
        if (contentIndent === undefined) leadingBlanks.push({ row, spaces: raw.length });
        chunks.push(contentIndent === undefined ? '' : raw.slice(contentIndent)); row++; continue;
      }
      const n = /^ */.exec(raw)![0].length;
      if (n <= parent) break;
      if (contentIndent === undefined) {
        contentIndent = n;
        for (const blank of leadingBlanks) if (blank.spaces > n) fail(blank.row, n, 'Leading blank line exceeds block scalar indentation');
      }
      if (n < contentIndent) fail(row, n, 'Invalid block scalar indentation');
      chunks.push(raw.slice(contentIndent)); row++;
    }
    const following: (string | undefined)[] = new Array(chunks.length);
    let nextContent: string | undefined;
    for (let i = chunks.length - 1; i >= 0; i--) {
      following[i] = nextContent;
      if (chunks[i]) nextContent = chunks[i];
    }
    let result = '';
    for (let i = 0; i < chunks.length; i++) {
      const current = chunks[i], next = chunks[i + 1];
      result += current;
      if (i === chunks.length - 1 && row === lines.length && !finalBreak) continue;
      if (match![1] === '>' && next !== undefined && current && next && !/^[ \t]/.test(current) && !/^[ \t]/.test(next)) result += ' ';
      else if (match![1] === '>' && current && !/^[ \t]/.test(current) && next === '' && following[i] && !/^[ \t]/.test(following[i]!)) { /* following empty lines supply the paragraph breaks */ }
      else result += '\n';
    }
    if (match![2] === '-') return result.replace(/\n+$/, '');
    if (match![2] === '+') return result;
    return result.replace(/\n+$/, '') + (chunks.some(s => s.length) && result.endsWith('\n') ? '\n' : '');
  }
  function remainder(source: string, parent: number, line: number, column: number, depth: number): YamlValue {
    if (empty(source)) {
      skip();
      if (row < lines.length && indent(row) > parent) return block(indent(row), depth);
      check(depth, line, column); return null;
    }
    if (/^[|>]/.test(source)) { check(depth, line, column); return blockString(source, parent, line, column); }
    return inline(source, line, column, depth);
  }
  function block(level: number, depth: number): YamlValue {
    skip(); const first = row, source = lines[row].slice(level);
    const sequence = /^-(?:[ \t]|$)/.test(source), mapping = !sequence && separator(source) >= 0;
    if (!sequence && !mapping) { row++; return remainder(source, level, first, level, depth); }
    check(depth, row, level);
    const result: YamlValue[] | Record<string, YamlValue> = sequence ? [] : Object.create(null);
    while (row < lines.length) {
      skip(); if (row >= lines.length) break;
      const n = indent(row);
      if (n < level || (n === 0 && /^(?:---|\.\.\.)(?:[ \t]|$)/.test(lines[row]))) break;
      if (n !== level) fail(row, n, 'Unexpected indentation; multiline plain scalars and indentless sequences are unsupported');
      const line = row, current = lines[row].slice(level);
      if (sequence) {
        if (!/^-(?:[ \t]|$)/.test(current)) fail(row, n, 'Expected a sequence item');
        const prefix = /^-[ \t]*/.exec(current)![0].length, rest = current.slice(prefix);
        if (!empty(rest) && (separator(rest) >= 0 || /^-(?:[ \t]|$)/.test(rest))) {
          lines[row] = ' '.repeat(level + prefix) + rest;
          (result as YamlValue[]).push(block(level + prefix, depth + 1));
        } else { row++; (result as YamlValue[]).push(remainder(rest, level, line, level + prefix, depth + 1)); }
      } else {
        const colon = separator(current);
        if (colon < 0) fail(row, level, 'Expected a mapping entry');
        const key = inline(current.slice(0, colon).trimEnd(), line, level, depth + 1);
        if (typeof key !== 'string') return fail(row, level, 'Mapping keys must be strings');
        if (key === '<<' && current[0] !== '"' && current[0] !== "'") fail(row, level, 'Merge keys are unsupported');
        if (Object.hasOwn(result, key)) fail(row, level, 'Duplicate mapping key');
        const start = colon + 1 + /^[ \t]*/.exec(current.slice(colon + 1))![0].length;
        row++; (result as Record<string, YamlValue>)[key] = remainder(current.slice(start), level, line, level + start, depth + 1);
      }
    }
    return result;
  }
  skip();
  if (row < lines.length && /^---(?:[ \t]*(?:#.*)?)$/.test(lines[row])) { row++; skip(); }
  if (row >= lines.length) return null;
  if (indent(row) !== 0) fail(row, 0, 'Root must start at column 1');
  if (/^\.\.\.(?:[ \t]*(?:#.*)?)$/.test(lines[row])) {
    row++; skip();
    if (row === lines.length) return null;
    fail(row, 0, 'Unexpected content after document end');
  }
  if (/^(?:---|\.\.\.)(?:[ \t]|$)/.test(lines[row])) fail(row, 0, 'Inline document markers and multiple documents are unsupported');
  const result = block(0, 0); skip();
  if (row < lines.length && /^\.\.\.(?:[ \t]*(?:#.*)?)$/.test(lines[row])) { row++; skip(); }
  if (row < lines.length) fail(row, 0, 'Only one document is supported; unexpected trailing content');
  return result;
}

/** Emit block YAML, quoting all string scalars and keys to avoid implicit typing. */
export function stringifyYaml(value: unknown): string {
  const active = new Set<object>(); let count = 0, size = 0;
  const output: string[] = [];
  function fail(path: string, message: string): never { throw new DocumentError(path, message); }
  function emit(line: string) {
    size += line.length + 1; if (size > MAX_TEXT) fail('$', 'YAML text exceeds 1000000 characters');
    output.push(line);
  }
  function quoted(value: string) { return JSON.stringify(value).replace(/[\x7f-\x9f\u2028\u2029\ufffe\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')); }
  function own(object: object, key: PropertyKey, path: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor)) fail(path, 'Expected an own data property');
    return descriptor.value;
  }
  function write(value: unknown, pad: string, prefix: string, path: string, depth: number) {
    if (depth > MAX_DEPTH || ++count > MAX_VALUES) fail(path, 'YAML depth or size limit exceeded');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
      if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) fail(path, 'Number is not portable');
      emit(pad + prefix + (typeof value === 'string' ? quoted(value) : String(value))); return;
    }
    if (!value || typeof value !== 'object') fail(path, 'Unsupported YAML value');
    if (active.has(value)) fail(path, 'Cyclic YAML value');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'Expected a plain object');
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_VALUES + (array ? 1 : 0)) fail(path, 'YAML size limit exceeded');
    if (array && keys.length !== value.length + 1) fail(path, 'Sparse arrays and extra array properties are unsupported');
    const entries: [string, unknown][] = array ? Array.from({ length: value.length }, (_, i) => [String(i), own(value, String(i), `${path}[${i}]`)]) : keys.map(key => {
      if (typeof key !== 'string') fail(path, 'Symbol keys are unsupported');
      return [key, own(value, key, `${path}[${JSON.stringify(key)}]`)];
    });
    if (entries.length === 0) { emit(pad + prefix + (array ? '[]' : '{}')); return; }
    active.add(value);
    if (prefix) { emit(pad + prefix.trimEnd()); pad += '  '; }
    for (const [key, child] of entries) {
      if (!array && ++count > MAX_VALUES) fail(path, 'YAML size limit exceeded');
      write(child, pad, array ? '- ' : quoted(key) + ': ', `${path}[${JSON.stringify(key)}]`, depth + 1);
    }
    active.delete(value);
  }
  write(value, '', '', '$', 0);
  return output.join('\n') + '\n';
}
