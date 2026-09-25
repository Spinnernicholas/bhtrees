export default {
  id: 'greeting', version: '1.0.0', apiVersion: 1,
  setup(api) {
    api.registerAction('greeting.run', {
      tick: ctx => ctx.success(`Hello, ${ctx.input.name}!`)
    });
  }
};
