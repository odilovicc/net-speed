import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { measureRequest, runBenchmark, withCacheBuster } from '../src/measure.js';
import { freePort, startServer } from './helpers.js';

describe('measureRequest', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  it('дочитывает тело целиком и считает байты', async () => {
    const size = 3 * 1024 * 1024 + 7; // не кратно размеру чанка
    const r = await measureRequest(server.url(`/bytes/${size}`));
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.bytes, size);
    assert.ok(r.durationMs > 0);
    assert.ok(r.ttfbMs !== undefined && r.ttfbMs <= r.durationMs);
  });

  it('просит несжатый и некэшированный ответ', async () => {
    await measureRequest(server.url('/bytes/1'));
    const headers = server.seenHeaders.at(-1);
    assert.equal(headers['accept-encoding'], 'identity');
    assert.equal(headers['cache-control'], 'no-cache');
  });

  it('проходит по редиректам', async () => {
    const r = await measureRequest(server.url('/redirect'));
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 100);
  });

  it('помечает не-2xx ответ как ошибку', async () => {
    const r = await measureRequest(server.url('/status/404'));
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.match(r.error ?? '', /HTTP 404/);
  });

  it('срабатывает таймаут, если тело не приходит', async () => {
    const r = await measureRequest(server.url('/slow'), { timeoutMs: 200 });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /таймаут 200/);
  });

  it('сообщает сетевую ошибку с кодом', async () => {
    const port = await freePort();
    const r = await measureRequest(`http://127.0.0.1:${port}/`, { timeoutMs: 2000 });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /ECONNREFUSED/);
  });
});

describe('runBenchmark', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  it('делает ровно count последовательных запросов', async () => {
    const seen = [];
    const results = await runBenchmark(server.url('/bytes/1000'), {
      count: 5,
      onResult: (r) => seen.push(r.index),
    });
    assert.equal(results.length, 5);
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    assert.ok(results.every((r) => r.ok && r.bytes === 1000));
  });

  it('с cacheBust добавляет уникальный параметр к каждому запросу', async () => {
    server.seenUrls.length = 0;
    await runBenchmark(server.url('/bytes/10?keep=1'), { count: 3, cacheBust: true });
    assert.equal(new Set(server.seenUrls).size, 3);
    assert.ok(server.seenUrls.every((u) => u.includes('keep=1') && u.includes('_nocache=')));
  });

  it('останавливается по внешнему сигналу', async () => {
    const controller = new AbortController();
    const results = await runBenchmark(server.url('/bytes/10'), {
      count: 10,
      signal: controller.signal,
      onResult: (r) => { if (r.index === 2) controller.abort(); },
    });
    assert.equal(results.length, 2);
  });
});

describe('withCacheBuster', () => {
  it('сохраняет существующие параметры', () => {
    const url = withCacheBuster('https://example.com/a.jpg?x=1', 4);
    assert.equal(url.searchParams.get('x'), '1');
    assert.match(url.searchParams.get('_nocache') ?? '', /-4$/);
  });
});
