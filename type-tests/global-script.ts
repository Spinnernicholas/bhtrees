import 'bhtrees/global';
// The script installs a global; it does not provide named module exports.
// @ts-expect-error Standalone entry has no named exports.
import type { createRunner as nonexistentExport } from 'bhtrees/global';
const standaloneTree = BHTrees.action({ id: 'global', tick: ctx => ctx.success('ok') });
const standaloneRunner = BHTrees.createRunner(standaloneTree);
const standaloneLoader = BHTrees.createBrowserExtensionLoader();
const standaloneGame = BHTrees.loadAdventureLandSession;
const standaloneYaml: string = BHTrees.stringifyYaml({ hello: 'world' });
