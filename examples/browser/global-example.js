// Ordinary script: the library is available through the BHTrees global.
(async function () {
  const result = document.getElementById('result');
  let loaded;
  try {
    const tree = BHTrees.action({ id: 'hello', tick: ctx => ctx.success('Hello from BHTrees!') });
    const greeting = BHTrees.createRunner(tree).tick().output;
    loaded = await BHTrees.loadBrowserTree('./loading/mission.yaml', { baseURI: location.href });
    const output = loaded.createRunner({ input: { name: 'Standalone' } }).tick().output;
    if (output !== 'Hello, Standalone!') throw new Error('Unexpected extension result');
    await loaded.dispose();
    result.textContent = `${greeting} ${output}`;
    document.body.dataset.result = 'pass';
  } catch (error) {
    result.textContent = error.message;
    document.body.dataset.result = 'fail';
  } finally {
    await loaded?.dispose();
  }
})();
