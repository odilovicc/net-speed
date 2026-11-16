#!/usr/bin/env node
import { run, EXIT } from '../src/cli.js';

const controller = new AbortController();

// Первый Ctrl+C — мягко останавливаемся и печатаем то, что успели замерить.
// Второй — выходим сразу.
process.on('SIGINT', () => {
  if (controller.signal.aborted) process.exit(EXIT.INTERRUPTED);
  controller.abort();
});

try {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    signal: controller.signal,
  });
} catch (error) {
  process.stderr.write(`Непредвиденная ошибка: ${error?.stack ?? error}\n`);
  process.exitCode = EXIT.FAILED;
}
