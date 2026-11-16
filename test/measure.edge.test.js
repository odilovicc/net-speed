import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { HttpError, measureRequest, runBenchmark } from '../src/measure.js';
import { startServer } from './helpers.js';

// Таймеры ОС могут сработать на пару миллисекунд раньше — даём допуск.
const TIMER_SLACK_MS = 5;

describe('measureRequest: граничные случаи', () => {
  let server;
  before(async () => { server = await startServer(); });
  beforeEach(() => server.reset());
  after(() => server.close());

  it('считает байты при chunked-ответе без Content-Length', async () => {
    const r = await measureRequest(server.url('/chunked/123457'));
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 123_457);
  });

  it('обрабатывает пустой ответ 204', async () => {
    const r = await measureRequest(server.url('/empty'));
    assert.equal(r.ok, true);
    assert.equal(r.status, 204);
    assert.equal(r.bytes, 0);
  });

  it('время запроса включает ожидание сервера', async () => {
    const r = await measureRequest(server.url('/delay/80'));
    assert.equal(r.ok, true);
    assert.ok(r.durationMs >= 80 - TIMER_SLACK_MS, `durationMs=${r.durationMs}`);
    assert.ok(r.ttfbMs !== undefined && r.ttfbMs >= 80 - TIMER_SLACK_MS, `ttfbMs=${r.ttfbMs}`);
    assert.ok(r.ttfbMs <= r.durationMs);
  });

  it('таймаут до получения заголовков', async () => {
    const r = await measureRequest(server.url('/delay/2000'), { timeoutMs: 100 });
    assert.equal(r.ok, false);
    assert.equal(r.status, undefined);
    assert.equal(r.ttfbMs, undefined);
    assert.match(r.error ?? '', /таймаут 100 мс/);
    assert.ok(r.durationMs < 1000, 'запрос должен прерваться по таймауту, а не дождаться ответа');
  });

  it('при таймауте посреди тела сохраняет статус и уже полученные байты', async () => {
    const r = await measureRequest(server.url('/slow'), { timeoutMs: 150 });
    assert.equal(r.ok, false);
    assert.equal(r.status, 200);
    assert.equal(r.bytes, 1);
    assert.ok(r.ttfbMs !== undefined);
  });

  it('прерывается внешним сигналом посреди запроса', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await measureRequest(server.url('/slow'), { signal: controller.signal, timeoutMs: 10_000 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'прервано');
    assert.ok(r.durationMs < 5000);
  });

  it('сообщает об ошибке при бесконечном редиректе', async () => {
    const r = await measureRequest(server.url('/loop'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /redirect/i);
  });

  for (const status of [400, 403, 404, 500, 503]) {
    it(`HTTP ${status} считается ошибкой`, async () => {
      const r = await measureRequest(server.url(`/status/${status}`));
      assert.equal(r.ok, false);
      assert.equal(r.status, status);
      assert.match(r.error ?? '', new RegExp(`^HTTP ${status}`));
    });
  }

  it('принимает URL-объект, а не только строку', async () => {
    const r = await measureRequest(new URL(server.url('/bytes/42')));
    assert.equal(r.bytes, 42);
  });

  it('пользовательские заголовки дополняют и перекрывают стандартные', async () => {
    await measureRequest(server.url('/bytes/1'), {
      headers: { 'x-custom': 'yes', 'user-agent': 'my-agent' },
    });
    const h = server.seenHeaders.at(-1);
    assert.equal(h['x-custom'], 'yes');
    assert.equal(h['user-agent'], 'my-agent');
    assert.equal(h['accept-encoding'], 'identity');
  });

  it('проставляет переданный index', async () => {
    const r = await measureRequest(server.url('/bytes/1'), { index: 7 });
    assert.equal(r.index, 7);
  });
});

describe('runBenchmark: последовательность и отмена', () => {
  let server;
  before(async () => { server = await startServer(); });
  beforeEach(() => server.reset());
  after(() => server.close());

  it('никогда не держит больше одного запроса одновременно', async () => {
    const started = performance.now();
    const results = await runBenchmark(server.url('/delay/30'), { count: 5 });
    const elapsed = performance.now() - started;

    assert.equal(server.stats.maxActive, 1);
    assert.equal(results.length, 5);
    // Параллельно было бы ~30 мс, последовательно — не меньше 5 × 30.
    assert.ok(elapsed >= 5 * 30 - 5 * TIMER_SLACK_MS, `elapsed=${elapsed}`);
  });

  it('продолжает после неудачных запросов', async () => {
    const results = await runBenchmark(server.url('/flaky'), { count: 4 });
    assert.deepEqual(results.map((r) => r.ok), [true, false, true, false]);
    assert.deepEqual(results.map((r) => r.index), [1, 2, 3, 4]);
  });

  it('не делает ни одного запроса, если сигнал уже отменён', async () => {
    const results = await runBenchmark(server.url('/bytes/10'), { count: 3, signal: AbortSignal.abort() });
    assert.deepEqual(results, []);
    assert.equal(server.seenUrls.length, 0);
  });

  it('по умолчанию не добавляет cache-buster', async () => {
    await runBenchmark(server.url('/bytes/10'), { count: 2 });
    assert.ok(server.seenUrls.every((u) => u === '/bytes/10'));
  });

  it('по умолчанию делает 10 запросов', async () => {
    const results = await runBenchmark(server.url('/bytes/10'));
    assert.equal(results.length, 10);
  });

  it('передаёт таймаут в каждый запрос', async () => {
    const results = await runBenchmark(server.url('/delay/2000'), { count: 2, timeoutMs: 50 });
    assert.ok(results.every((r) => !r.ok && /таймаут 50/.test(r.error ?? '')));
  });
});

describe('HttpError', () => {
  it('содержит статус и читаемое сообщение', () => {
    const e = new HttpError(418, "I'm a teapot");
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'HttpError');
    assert.equal(e.status, 418);
    assert.equal(e.message, "HTTP 418 I'm a teapot");
    assert.equal(new HttpError(500, '').message, 'HTTP 500');
  });
});
