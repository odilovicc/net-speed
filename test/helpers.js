import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { Writable } from 'node:stream';

/**
 * Локальный сервер для тестов, чтобы не зависеть от интернета.
 *   /bytes/<n>    — отдаёт ровно n байт
 *   /status/<code> — отвечает указанным статусом
 *   /slow          — отправляет заголовки и зависает
 */
export async function startServer() {
  /** @type {string[]} */
  const seenUrls = [];
  /** @type {import('node:http').IncomingHttpHeaders[]} */
  const seenHeaders = [];

  const server = createServer((req, res) => {
    seenUrls.push(req.url ?? '');
    seenHeaders.push(req.headers);
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const [, route, arg] = pathname.split('/');

    if (route === 'bytes') {
      const size = Number(arg);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
      // Пишем кусками, чтобы проверить подсчёт по потоку, а не по content-length.
      const chunk = Buffer.alloc(64 * 1024, 1);
      let left = size;
      while (left > 0) {
        const n = Math.min(left, chunk.length);
        res.write(chunk.subarray(0, n));
        left -= n;
      }
      res.end();
      return;
    }
    if (route === 'status') {
      res.writeHead(Number(arg));
      res.end('error body');
      return;
    }
    if (route === 'slow') {
      res.writeHead(200);
      res.write('x');
      return; // никогда не завершаем ответ
    }
    if (route === 'redirect') {
      res.writeHead(302, { location: '/bytes/100' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    seenUrls,
    seenHeaders,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** Поток-заглушка, который копит всё записанное в строку. */
export function captureStream({ isTTY = false } = {}) {
  let data = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      data += chunk.toString();
      cb();
    },
  });
  return Object.defineProperties(stream, {
    isTTY: { value: isTTY },
    output: { get: () => data },
  });
}

/** Порт, на котором гарантированно никто не слушает. */
export async function freePort() {
  const srv = createTcpServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
  await new Promise((resolve) => srv.close(resolve));
  return port;
}
