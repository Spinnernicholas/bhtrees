/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createExtensionLoader } from './extensions.js';
import type { ExtensionLoader, ExtensionLoaderOptions } from './extensions.js';
import { loadConfiguredTree } from './config-loader.js';
import type { ConfigFileContent, ConfiguredTree, ConfiguredTreeOptions } from './config-loader.js';

/** Convert a filesystem path (relative to cwd) or file URL into a file URL. */
export function toFileURI(path: string | URL): string {
  const url = path instanceof URL ? path :
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path) && !/^[a-zA-Z]:[\\/]/.test(path)
      ? new URL(path) : pathToFileURL(resolve(path));
  if (url.protocol !== 'file:') throw new TypeError('Expected a filesystem path or file URL');
  if (url.search || url.hash) throw new TypeError('File URLs must not contain a query or fragment');
  fileURLToPath(url); // Validate host and encoded path separators before host I/O.
  return url.href;
}

export async function readNodeConfig(uri: string): Promise<ConfigFileContent> {
  const url = new URL(toFileURI(new URL(uri)));
  const path = fileURLToPath(url);
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  const codec = extension === '.json' ? 'json' : ['.yaml', '.yml'].includes(extension) ? 'yaml' : undefined;
  if (!codec) throw new TypeError(`Cannot infer document codec from ${uri}; expected .json, .yaml or .yml`);
  return { text: await readFile(url, 'utf8'), codec };
}

export interface NodeExtensionLoaderOptions extends Omit<ExtensionLoaderOptions, 'importModule' | 'resolveName'> {
  /** Host file used as the base for Node's createRequire().resolve package lookup. */
  baseURI: string | URL;
  /** Optional manifest-name to installed-package/subpath mappings. */
  packages?: Readonly<Record<string, string>>;
}

export function createNodeExtensionLoader(options: NodeExtensionLoaderOptions): ExtensionLoader {
  const require = createRequire(toFileURI(options.baseURI));
  const packages = new Map(Object.entries(options.packages ?? {}));
  return createExtensionLoader({
    builtins: options.builtins, catalog: options.catalog, allowModule: options.allowModule,
    resolveName(name) {
      const specifier = packages.get(name) ?? name;
      if (typeof specifier !== 'string' || !specifier || isBuiltin(specifier) || specifier.startsWith('.') ||
          specifier.startsWith('/') || specifier.includes('\\') || specifier.includes(':') || specifier.startsWith('#')) {
        throw new TypeError('Expected an installed package name or package subpath');
      }
      return pathToFileURL(require.resolve(specifier)).href;
    },
    importModule(uri) { return import(toFileURI(new URL(uri))); }
  });
}

export interface NodeTreeOptions extends Omit<ConfiguredTreeOptions, 'baseURI'> {
  /** Used only when no custom extensionLoader is supplied. */
  extensions?: Omit<NodeExtensionLoaderOptions, 'baseURI'>;
}

/** Read a tree and its referenced configuration; resolve packages beside the tree file. */
export async function loadNodeTree(path: string | URL, options: NodeTreeOptions = {}): Promise<ConfiguredTree> {
  const baseURI = toFileURI(path);
  const file = options.codec
    ? { text: await readFile(new URL(baseURI), 'utf8'), codec: options.codec }
    : await readNodeConfig(baseURI);
  const { extensions, ...treeOptions } = options;
  return loadConfiguredTree(file.text, {
    ...treeOptions, codec: file.codec, baseURI,
    readConfig: options.readConfig ?? readNodeConfig,
    extensionLoader: options.extensionLoader ?? createNodeExtensionLoader({ ...extensions, baseURI })
  });
}
