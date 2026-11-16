import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { Writable } from 'node:stream';

/**
 * Локальный сервер для тестов, чтобы не зависеть от интернета.
 *   /bytes/<n>    — отдаёт ровно n байт
 *   /status/<code> — отвечает указанным статусом
 *   /slow          — отправляет заголовки и зависает
 *   /chunked/<n>   — n байт без Content-Length (Transfer-Encoding: chunked)
 *   /empty         — 204 No Content
 *   /delay/<ms>    — ждёт ms, затем отдаёт 1000 байт
 *   /flaky         — чередует 200 и 500
 *   /redirect      — 302 на /bytes/100
 *   /loop          — бесконечный редирект на себя
 *
 * Сервер считает, сколько запросов обрабатывается одновременно (maxActive),
 * чтобы тесты могли проверить строгую последовательность.
 */
export async function startServer() {
  /** @type {string[]} */
  const seenUrls = [];
  /** @type {import('node:http').IncomingHttpHeaders[]} */
  const seenHeaders = [];
  const stats = { active: 0, maxActive: 0, flaky: 0 };

  const server = createServer((req, res) => {
    seenUrls.push(req.url ?? '');
    seenHeaders.push(req.headers);
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    res.on('close', () => { stats.active -= 1; });
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
    if (route === 'chunked') {
      res.writeHead(200); // без content-length Node включает chunked-кодирование
      res.end(Buffer.alloc(Number(arg), 2));
      return;
    }
    if (route === 'empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (route === 'delay') {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-length': 1000 });
        res.end(Buffer.alloc(1000));
      }, Number(arg));
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (route === 'flaky') {
      stats.flaky += 1;
      res.writeHead(stats.flaky % 2 ? 200 : 500);
      res.end(Buffer.alloc(500));
      return;
    }
    if (route === 'loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
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
    stats,
    reset() {
      seenUrls.length = 0;
      seenHeaders.length = 0;
      Object.assign(stats, { maxActive: 0, flaky: 0 });
    },
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
