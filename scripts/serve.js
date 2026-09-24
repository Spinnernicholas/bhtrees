import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, extname, isAbsolute } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
export function createExampleServer() {
  return createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (['/', '/examples/browser', '/examples/browser/'].includes(pathname)) {
        response.writeHead(302, { Location: '/examples/browser/index.html', 'Cache-Control': 'no-store' }).end();
        return;
      }
      // Only serve public example assets and the source modules they import.
      if (!pathname.startsWith('/examples/browser/') && !pathname.startsWith('/src/')) {
        response.writeHead(404).end(); return;
      }
      const file = await realpath(resolve(root, `.${pathname}`));
      const local = relative(root, file);
      if (local.startsWith('..') || isAbsolute(local) || !types[extname(file)]) { response.writeHead(404).end(); return; }
      const portable = local.replaceAll('\\', '/');
      if (!portable.startsWith('src/') && !portable.startsWith('examples/browser/')) { response.writeHead(404).end(); return; }
      const bytes = await readFile(file);
      response.writeHead(200, { 'Content-Type': `${types[extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404).end(); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const server = createExampleServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`BHTrees playground: http://127.0.0.1:${server.address().port}`));
}
