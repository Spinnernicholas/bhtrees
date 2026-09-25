import test from 'node:test';
import assert from 'node:assert/strict';
import { createExampleServer } from '../scripts/serve.js';

test('browser server serves HTML and modules but not project metadata', async t => {
  const server = createExampleServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url);
  const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /Browser playground/);
  assert.equal(new URL(page.url).pathname, '/examples/browser/index.html');
  for (const [, asset] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const resource = await fetch(new URL(asset, page.url));
    assert.equal(resource.status, 200, `Asset failed to load: ${asset}`);
    assert.match(resource.headers.get('content-type'), asset.endsWith('.css') ? /text\/css/ : /javascript/);
  }
  const mission = await fetch(`${url}/examples/browser/mission.json`);
  assert.equal(mission.status, 200);
  assert.match(mission.headers.get('content-type'), /application\/json/);
  assert.equal((await mission.json()).kind, 'tree');
  const yamlMission = await fetch(`${url}/examples/browser/mission.yaml`);
  assert.equal(yamlMission.status, 200);
  assert.match(yamlMission.headers.get('content-type'), /application\/yaml/);
  assert.match(await yamlMission.text(), /format: bhtrees-example/);
  const module = await fetch(`${url}/dist/index.js`);
  assert.match(module.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${url}/package.json`)).status, 404);
  assert.equal((await fetch(`${url}/dist/%2e%2e%2fpackage.json`)).status, 404);
});
