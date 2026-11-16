import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { EXIT, parseOptions, run } from '../src/cli.js';
import { captureStream, startServer } from './helpers.js';

const ANSI = /\x1b\[\d+m/;

async function exec(argv, { tty = false, env = {}, signal } = {}) {
  const stdout = captureStream({ isTTY: tty });
  const stderr = captureStream();
  const code = await run(argv, { stdout, stderr, env, signal });
  return { code, stdout: stdout.output, stderr: stderr.output };
}

describe('parseOptions: дополнительные случаи', () => {
  it('длинные и короткие формы опций равнозначны', () => {
    const short = parseOptions(['a.com', '-n', '3', '-t', '5']);
    const long = parseOptions(['a.com', '--count', '3', '--timeout', '5']);
    assert.deepEqual(short, long);
    assert.equal(parseOptions(['a.com', '--count=4']).count, 4);
  });

  it('дробный таймаут переводится в миллисекунды', () => {
    assert.equal(parseOptions(['a.com', '-t', '0.5']).timeoutMs, 500);
    assert.equal(parseOptions(['a.com', '-t', '1.2345']).timeoutMs, 1235);
  });

  it('флаги --cache-bust и --json', () => {
    const o = parseOptions(['a.com', '--cache-bust', '--json']);
    assert.equal(o.cacheBust, true);
    assert.equal(o.json, true);
  });

  it('граница --count: 1 и 1000 допустимы, 1001 и -1 — нет', () => {
    assert.equal(parseOptions(['a.com', '-n', '1']).count, 1);
    assert.equal(parseOptions(['a.com', '-n', '1000']).count, 1000);
    assert.throws(() => parseOptions(['a.com', '-n', '1001']), /--count/);
    assert.throws(() => parseOptions(['a.com', '-n', '-1']), /--count/);
    assert.throws(() => parseOptions(['a.com', '-n', 'abc']), /--count/);
  });

  it('отрицательный и нулевой таймаут отклоняются', () => {
    assert.throws(() => parseOptions(['a.com', '-t', '0']), /--timeout/);
    assert.throws(() => parseOptions(['a.com', '-t', '-3']), /--timeout/);
    assert.throws(() => parseOptions(['a.com', '-t', 'Infinity']), /--timeout/);
  });

  it('URL: схема, порт, query и регистр сохраняются', () => {
    assert.equal(parseOptions(['http://host:8080/a?b=1']).url.href, 'http://host:8080/a?b=1');
    assert.equal(parseOptions(['HTTPS://Example.com/X']).url.href, 'https://example.com/X');
    assert.equal(parseOptions(['localhost:3000/file']).url.href, 'https://localhost:3000/file');
  });

  it('URL: некорректные адреса отклоняются', () => {
    assert.throws(() => parseOptions(['http://']), /некорректный URL/);
    assert.throws(() => parseOptions(['https://exa mple.com']), /некорректный URL/);
    assert.throws(() => parseOptions(['file:///etc/passwd']), /только http и https/);
    assert.throws(() => parseOptions(['ws://a.com']), /только http и https/);
  });

  it('--help и --version не требуют URL', () => {
    assert.equal(parseOptions(['-h']).help, true);
    assert.equal(parseOptions(['--version']).version, true);
  });
});

describe('run: вывод', () => {
  let server;
  before(async () => { server = await startServer(); });
  beforeEach(() => server.reset());
  after(() => server.close());

  it('заголовок содержит URL, число запросов и таймаут', async () => {
    const url = server.url('/bytes/10');
    const { stdout } = await exec([url, '-n', '2', '-t', '7']);
    assert.ok(stdout.startsWith(`Замер скорости ${url}`));
    assert.match(stdout, /Запросов: 2, последовательно; таймаут: 7 с/);
  });

  it('печатает по строке на каждый запрос', async () => {
    const { stdout } = await exec([server.url('/bytes/10'), '-n', '4']);
    const rows = stdout.split('\n').filter((line) => /^\d+\s+200\s/.test(line));
    assert.deepEqual(rows.map((r) => r.split(/\s+/)[0]), ['1', '2', '3', '4']);
  });

  it('частичные ошибки: код 0, предупреждение и ошибка в таблице', async () => {
    const { code, stdout } = await exec([server.url('/flaky'), '-n', '4']);
    assert.equal(code, EXIT.OK);
    assert.match(stdout, /Успешных запросов:\s+2 из 4/);
    assert.match(stdout, /HTTP 500/);
    assert.match(stdout, /2 запрос\(ов\) завершились ошибкой/);
    assert.match(stdout, /Скачано всего:\s+1\.0 КБ \(1\s000 байт\)/);
  });

  it('советует взять файл побольше, если скачано меньше 1 МБ', async () => {
    assert.match((await exec([server.url('/bytes/1000'), '-n', '1'])).stdout, /Совет: объём меньше 1 МБ/);
    assert.doesNotMatch((await exec([server.url('/bytes/1000000'), '-n', '1'])).stdout, /Совет/);
  });

  it('без ошибок не печатает предупреждение об ошибках', async () => {
    const { stdout } = await exec([server.url('/bytes/1000000'), '-n', '2']);
    assert.doesNotMatch(stdout, /завершились ошибкой/);
  });

  it('прерывание: код 130 и сообщение', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const { code, stdout } = await exec([server.url('/slow'), '-n', '5'], { signal: controller.signal });
    assert.equal(code, EXIT.INTERRUPTED);
    assert.match(stdout, /Прервано пользователем после 1 из 5 запросов/);
    assert.doesNotMatch(stdout, /Первый запрос не удался/, 'Ctrl+C — не то же самое, что неверная ссылка');
  });

  it('прерывание после успешных запросов всё равно показывает итог', async () => {
    const controller = new AbortController();
    const stdout = captureStream();
    const promise = run([server.url('/delay/40'), '-n', '50'], {
      stdout,
      stderr: captureStream(),
      env: {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    assert.equal(await promise, EXIT.INTERRUPTED);
    assert.match(stdout.output, /Прервано пользователем/);
    assert.match(stdout.output, /Скорость скачивания:/);
  });

  it('ошибки аргументов идут в stderr, а stdout пуст', async () => {
    const { code, stdout, stderr } = await exec(['ftp://a.com']);
    assert.equal(code, EXIT.USAGE);
    assert.equal(stdout, '');
    assert.match(stderr, /только http и https/);
    assert.match(stderr, /net-speed --help/);
  });
});

describe('run: цвета', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  it('в TTY выводит ANSI-цвета', async () => {
    assert.match((await exec([server.url('/bytes/10'), '-n', '1'], { tty: true })).stdout, ANSI);
  });

  it('уважает NO_COLOR', async () => {
    const { stdout } = await exec([server.url('/bytes/10'), '-n', '1'], { tty: true, env: { NO_COLOR: '1' } });
    assert.doesNotMatch(stdout, ANSI);
  });

  it('не красит при TERM=dumb', async () => {
    const { stdout } = await exec([server.url('/bytes/10'), '-n', '1'], { tty: true, env: { TERM: 'dumb' } });
    assert.doesNotMatch(stdout, ANSI);
  });

  it('JSON никогда не красится', async () => {
    const { stdout } = await exec([server.url('/bytes/10'), '-n', '1', '--json'], { tty: true });
    assert.doesNotMatch(stdout, ANSI);
    JSON.parse(stdout);
  });
});

describe('run: JSON', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  it('содержит единицы, параметры и согласованные значения скорости', async () => {
    const url = server.url('/bytes/250000');
    const { stdout } = await exec([url, '-n', '3', '--json']);
    const data = JSON.parse(stdout);

    assert.equal(data.url, url);
    assert.equal(data.requested, 3);
    assert.equal(data.interrupted, false);
    assert.deepEqual(Object.keys(data.units).sort(), ['bytes', 'speed', 'time']);

    const s = data.summary;
    assert.equal(s.totalBytes, 750_000);
    assert.equal(s.succeeded, 3);
    assert.ok(Math.abs(s.mbps - (s.bytesPerSecond * 8) / 1e6) < 1e-9);
    assert.ok(Math.abs(s.megabytesPerSecond - s.bytesPerSecond / 1e6) < 1e-9);
    assert.ok(Math.abs(s.bytesPerSecond - s.totalBytes / (s.totalTimeMs / 1000)) < 1e-6);
  });

  it('у каждого результата полный набор полей', async () => {
    const { stdout } = await exec([server.url('/bytes/10'), '-n', '2', '--json']);
    for (const r of JSON.parse(stdout).results) {
      assert.deepEqual(Object.keys(r).sort(), ['bytes', 'durationMs', 'index', 'ok', 'status', 'ttfbMs']);
    }
  });

  it('при полном провале summary = null, код 1, ошибки в results', async () => {
    const { code, stdout } = await exec([server.url('/status/503'), '-n', '2', '--json']);
    const data = JSON.parse(stdout);
    assert.equal(code, EXIT.FAILED);
    assert.equal(data.summary, null);
    assert.ok(data.results.every((r) => r.ok === false && r.status === 503 && r.error));
  });

  it('при прерывании interrupted = true и код 130', async () => {
    const { code, stdout } = await exec([server.url('/bytes/10'), '--json'], { signal: AbortSignal.abort() });
    const data = JSON.parse(stdout);
    assert.equal(code, EXIT.INTERRUPTED);
    assert.equal(data.interrupted, true);
    assert.deepEqual(data.results, []);
  });

  it('в JSON-режиме в stdout нет ничего, кроме JSON', async () => {
    const { stdout } = await exec([server.url('/bytes/10'), '-n', '1', '--json']);
    assert.ok(stdout.trimStart().startsWith('{'));
    assert.ok(stdout.trimEnd().endsWith('}'));
  });
});
