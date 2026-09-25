import { createExtensionLoader } from './extensions.js';
import type { ExtensionLoader, ExtensionLoaderOptions } from './extensions.js';
import { loadConfiguredTree } from './config-loader.js';
import type { ConfigFileContent, ConfiguredTree, ConfiguredTreeOptions } from './config-loader.js';

function httpURI(path: string | URL, baseURI?: string | URL): string {
  const url = new URL(String(path), baseURI);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Expected an HTTP(S) URL');
  if (url.username || url.password || url.hash) throw new TypeError('Document/module URLs must not contain credentials or fragments');
  return url.href;
}

export interface BrowserDocumentOptions {
  /** Required for relative URLs; no implicit document/location global is used. */
  baseURI?: string | URL;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  allowDocument?: (uri: string) => boolean | Promise<boolean>;
}

async function readDocument(path: string | URL, options: BrowserDocumentOptions, codec?: 'json' | 'yaml'): Promise<ConfigFileContent> {
  const uri = httpURI(path, options.baseURI);
  options.signal?.throwIfAborted();
  if (options.allowDocument && await options.allowDocument(uri) !== true) throw new Error(`Document denied by host policy: ${uri}`);
  const extension = new URL(uri).pathname.split('.').at(-1)?.toLowerCase();
  const format = codec ?? (extension === 'json' ? 'json' : ['yaml', 'yml'].includes(extension ?? '') ? 'yaml' : undefined);
  if (!format) throw new TypeError(`Cannot infer document codec from ${uri}; expected .json, .yaml or .yml`);
  options.signal?.throwIfAborted();
  const request = options.fetch ?? globalThis.fetch;
  if (typeof request !== 'function') throw new TypeError('A fetch implementation is required');
  const response = await request(uri, { signal: options.signal, redirect: 'error' });
  if (!response.ok) throw new Error(`Document request failed (${response.status}): ${uri}`);
  // Redirects would change the base for config-relative paths and provenance.
  if (response.redirected || (response.url && response.url !== uri)) throw new Error(`Document redirects are not supported: ${uri}`);
  const text = await response.text();
  options.signal?.throwIfAborted();
  return { text, codec: format };
}

export function readBrowserConfig(uri: string, options: BrowserDocumentOptions = {}): Promise<ConfigFileContent> {
  return readDocument(uri, options);
}

export interface BrowserExtensionLoaderOptions extends ExtensionLoaderOptions {
  /** Base for relative catalog entries and resolveName results. */
  baseURI?: string | URL;
}

export function createBrowserExtensionLoader(options: BrowserExtensionLoaderOptions = {}): ExtensionLoader {
  const catalog = Object.fromEntries(Object.entries(options.catalog ?? {}).map(([name, value]) =>
    [name, typeof value === 'string' ? httpURI(value, options.baseURI) : value]));
  const resolveName = options.resolveName;
  return createExtensionLoader({
    builtins: options.builtins, catalog,
    resolveName: resolveName ? async name => httpURI(await resolveName(name), options.baseURI) : undefined,
    async allowModule(uri) {
      httpURI(uri);
      return options.allowModule ? await options.allowModule(uri) : true;
    },
    importModule: options.importModule ?? (uri => import(uri))
  });
}

export interface BrowserTreeOptions extends Omit<ConfiguredTreeOptions, 'baseURI'>, BrowserDocumentOptions {
  extensions?: BrowserExtensionLoaderOptions;
}

/** Fetch a portable tree; relative extension paths retain their declaring document's base. */
export async function loadBrowserTree(path: string | URL, options: BrowserTreeOptions = {}): Promise<ConfiguredTree> {
  const baseURI = httpURI(path, options.baseURI);
  const file = await readDocument(baseURI, options, options.codec);
  const { extensions, fetch: _fetch, signal, allowDocument: _policy, baseURI: _base, ...treeOptions } = options;
  const loaded = await loadConfiguredTree(file.text, {
    ...treeOptions, baseURI, codec: file.codec,
    readConfig: options.readConfig ?? (uri => readBrowserConfig(uri, options)),
    extensionLoader: options.extensionLoader ?? createBrowserExtensionLoader({ baseURI, ...extensions })
  });
  if (signal?.aborted) {
    try { await loaded.dispose(); }
    catch (error) { throw new AggregateError([signal.reason, error], 'Loading aborted and cleanup failed'); }
    signal.throwIfAborted();
  }
  return loaded;
}
