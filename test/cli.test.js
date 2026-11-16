import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { EXIT, parseOptions, run } from '../src/cli.js';
import { captureStream, startServer } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/net-speed.js', import.meta.url));

async function exec(argv, extra = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await run(argv, { stdout, stderr, env: {}, ...extra });
  return { code, stdout: stdout.output, stderr: stderr.output };
}

describe('parseOptions', () => {
  it('значения по умолчанию', () => {
    const o = parseOptions(['https://example.com/x.jpg']);
    assert.equal(o.count, 10);
    assert.equal(o.timeoutMs, 30_000);
    assert.equal(o.cacheBust, false);
    assert.equal(o.json, false);
  });

  it('добавляет https://, если схема не указана', () => {
    assert.equal(parseOptions(['example.com/x.jpg']).url.href, 'https://example.com/x.jpg');
  });

  it('валидирует аргументы', () => {
    assert.throws(() => parseOptions([]), /не указан URL/);
    assert.throws(() => parseOptions(['a.com', 'b.com']), /один URL/);
    assert.throws(() => parseOptions(['ftp://a.com/x']), /только http и https/);
    assert.throws(() => parseOptions(['a.com', '-n', '0']), /--count/);
    assert.throws(() => parseOptions(['a.com', '-n', '2.5']), /--count/);
    assert.throws(() => parseOptions(['a.com', '-t', 'abc']), /--timeout/);
    assert.throws(() => parseOptions(['a.com', '--unknown']), /Unknown option/);
  });
});

describe('run', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  it('печатает таблицу и итоговую скорость', async () => {
    const { code, stdout } = await exec([server.url('/bytes/2000000'), '-n', '3']);
    assert.equal(code, EXIT.OK);
    assert.match(stdout, /Успешных запросов:\s+3 из 3/);
    assert.match(stdout, /Скачано всего:\s+6\.00 МБ/);
    assert.match(stdout, /Среднее время запроса:/);
    assert.match(stdout, /Скорость скачивания:\s+[\d.]+ Мбит\/с/);
    assert.doesNotMatch(stdout, /\x1b\[/, 'без TTY не должно быть ANSI-цветов');
  });

  it('по умолчанию делает 10 запросов', async () => {
    server.seenUrls.length = 0;
    const { code } = await exec([server.url('/bytes/1000')]);
    assert.equal(code, EXIT.OK);
    assert.equal(server.seenUrls.length, 10);
  });

  it('--json выдаёт валидный JSON', async () => {
    const { code, stdout } = await exec([server.url('/bytes/1000'), '-n', '2', '--json']);
    assert.equal(code, EXIT.OK);
    const data = JSON.parse(stdout);
    assert.equal(data.results.length, 2);
    assert.equal(data.summary.totalBytes, 2000);
    assert.equal(typeof data.summary.mbps, 'number');
  });

  it('возвращает код 1, если все запросы упали', async () => {
    const { code, stdout } = await exec([server.url('/status/500'), '-n', '2']);
    assert.equal(code, EXIT.FAILED);
    assert.match(stdout, /HTTP 500/);
    assert.match(stdout, /Ни один запрос не завершился успешно/);
  });

  it('возвращает код 2 при ошибке аргументов', async () => {
    const { code, stderr } = await exec(['-n', '5']);
    assert.equal(code, EXIT.USAGE);
    assert.match(stderr, /не указан URL/);
  });

  it('--help и --version', async () => {
    assert.match((await exec(['--help'])).stdout, /Использование/);
    assert.match((await exec(['-v'])).stdout, /^\d+\.\d+\.\d+\n$/);
  });
});

describe('bin', () => {
  it('запускается как исполняемый файл', () => {
    const r = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^\d+\.\d+\.\d+/);
  });
});
