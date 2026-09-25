import { loadNodeTree } from '../dist/node.js';

const loaded = await loadNodeTree(new URL('./node-files/mission.yaml', import.meta.url));
try {
  console.log(loaded.createRunner({ input: { name: 'Explorer' } }).tick().output);
} finally {
  await loaded.dispose();
}
