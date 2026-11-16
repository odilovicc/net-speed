// Первый запрос — проверка адреса: при неверной ссылке остальные не отправляются.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import { runBenchmark } from '../src/measure.js';
import { EXIT, run } from '../src/cli.js';
import { captureStream, freePort, startServer } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/net-speed.js', import.meta.url));

async function exec(argv) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await run(argv, { stdout, stderr, env: {} });
  return { code, stdout: stdout.output, stderr: stderr.output };
}

describe('fail-fast: runBenchmark', () => {
  let server;
  before(async () => { server = await startServer(); });
  beforeEach(() => server.reset());
  after(() => server.close());

  for (const path of ['/status/404', '/status/500', '/loop']) {
    it(`после неудачного первого запроса (${path}) остальные не отправляются`, async () => {
      const seen = [];
      const results = await runBenchmark(server.url(path), { count: 10, onResult: (r) => seen.push(r.index) });
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, false);
      assert.deepEqual(seen, [1]);
    });
  }

  it('сервер действительно получает ровно один запрос', async () => {
    await runBenchmark(server.url('/status/404'), { count: 10 });
    assert.equal(server.seenUrls.length, 1);
  });

  it('недоступный хост: один запрос, без ожидания остальных', async () => {
    const port = await freePort();
    const results = await runBenchmark(`http://127.0.0.1:${port}/`, { count: 10 });
    assert.equal(results.length, 1);
    assert.match(results[0].error ?? '', /ECONNREFUSED/);
  });

  it('таймаут первого запроса тоже останавливает замер', async () => {
    const started = performance.now();
    const results = await runBenchmark(server.url('/delay/5000'), { count: 10, timeoutMs: 100 });
    assert.equal(results.length, 1);
    assert.ok(performance.now() - started < 2000, 'не должны ждать 10 таймаутов подряд');
  });

  it('ошибки после успешного первого запроса замер не останавливают', async () => {
    // /flaky: 200, 500, 200, 500, ...
    const results = await runBenchmark(server.url('/flaky'), { count: 6 });
    assert.equal(results.length, 6);
    assert.deepEqual(results.map((r) => r.ok), [true, false, true, false, true, false]);
  });

  it('stopOnFirstFailure: false — отправляются все запросы', async () => {
    const results = await runBenchmark(server.url('/status/404'), { count: 4, stopOnFirstFailure: false });
    assert.equal(results.length, 4);
    assert.equal(server.seenUrls.length, 4);
  });

  it('при count = 1 поведение не меняется', async () => {
    const results = await runBenchmark(server.url('/status/404'), { count: 1 });
    assert.equal(results.length, 1);
  });
});

describe('fail-fast: CLI', () => {
  let server;
  before(async () => { server = await startServer(); });
  beforeEach(() => server.reset());
  after(() => server.close());

  it('сообщает, что замер остановлен, и сколько запросов не отправлено', async () => {
    const { code, stdout } = await exec([server.url('/status/404'), '-n', '10']);
    assert.equal(code, EXIT.FAILED);
    assert.equal(server.seenUrls.length, 1);
    assert.match(stdout, /HTTP 404/);
    assert.match(stdout, /Первый запрос не удался — замер остановлен, не отправлено запросов: 9\. Проверьте адрес\./);
    assert.doesNotMatch(stdout, /Ни один запрос/);
    assert.doesNotMatch(stdout, /Итого/);
  });

  it('в таблице ровно одна строка', async () => {
    const { stdout } = await exec([server.url('/status/404'), '-n', '10']);
    const rows = stdout.split('\n').filter((line) => /^\d+\s/.test(line));
    assert.equal(rows.length, 1);
  });

  it('--json: stoppedEarly = true, один результат, summary = null', async () => {
    const { code, stdout } = await exec([server.url('/status/404'), '-n', '10', '--json']);
    const data = JSON.parse(stdout);
    assert.equal(code, EXIT.FAILED);
    assert.equal(data.stoppedEarly, true);
    assert.equal(data.interrupted, false);
    assert.equal(data.requested, 10);
    assert.equal(data.results.length, 1);
    assert.equal(data.summary, null);
  });

  it('--json: при успешном замере stoppedEarly = false', async () => {
    const { stdout } = await exec([server.url('/bytes/10'), '-n', '3', '--json']);
    assert.equal(JSON.parse(stdout).stoppedEarly, false);
  });

  it('частичные ошибки после успешного первого запроса — не fail-fast', async () => {
    const { code, stdout } = await exec([server.url('/flaky'), '-n', '4']);
    assert.equal(code, EXIT.OK);
    assert.doesNotMatch(stdout, /замер остановлен/);
    assert.match(stdout, /Успешных запросов:\s+2 из 4/);
  });

  it('e2e: бинарник с недоступным адресом делает одну попытку и выходит с кодом 1', async () => {
    const port = await freePort();
    const r = spawnSync(process.execPath, [BIN, `http://127.0.0.1:${port}/x.jpg`], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 10_000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /ECONNREFUSED/);
    assert.match(r.stdout, /не отправлено запросов: 9/);
  });
});
