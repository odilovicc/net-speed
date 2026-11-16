// Сквозные тесты: запускаем настоящий исполняемый файл отдельным процессом.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startServer } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/net-speed.js', import.meta.url));

/**
 * Запускает CLI и ждёт завершения.
 * @param {string[]} args
 * @param {{ onStdout?: (text: string, child: import('node:child_process').ChildProcess) => void }} [opts]
 */
function runBin(args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      onStdout?.(stdout, child);
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe('bin (e2e)', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  it('успешный замер: код 0 и итоговая скорость', async () => {
    const r = await runBin([server.url('/bytes/500000'), '-n', '3']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Успешных запросов:\s+3 из 3/);
    assert.match(r.stdout, /Скорость скачивания:\s+[\d.]+ Мбит\/с/);
    assert.equal(r.stderr, '');
  });

  it('все запросы упали: код 1', async () => {
    const r = await runBin([server.url('/status/500'), '-n', '2']);
    assert.equal(r.code, 1);
  });

  it('ошибка аргументов: код 2, сообщение в stderr', async () => {
    const r = await runBin(['--count', 'x', 'a.com']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--count/);
  });

  it('--json из процесса парсится', async () => {
    const r = await runBin([server.url('/bytes/100'), '-n', '2', '--json']);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).summary.totalBytes, 200);
  });

  it('Ctrl+C (SIGINT) мягко останавливает замер с кодом 130', {
    skip: process.platform === 'win32' && 'на Windows нет POSIX-сигналов',
    timeout: 15_000,
  }, async () => {
    let sent = false;
    const r = await runBin([server.url('/slow'), '-n', '5', '-t', '60'], {
      // Ждём, пока CLI напечатает шапку таблицы и начнёт первый запрос.
      onStdout: (text, child) => {
        if (!sent && text.includes('Скорость')) {
          sent = true;
          setTimeout(() => child.kill('SIGINT'), 100);
        }
      },
    });
    assert.equal(sent, true);
    assert.equal(r.code, 130);
    assert.match(r.stdout, /ошибка: прервано/);
    assert.match(r.stdout, /Прервано пользователем после 1 из 5 запросов/);
  });
});
