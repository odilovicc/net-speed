import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runBenchmark } from './measure.js';
import { summarize } from './stats.js';
import {
  formatBytes,
  formatDuration,
  formatInt,
  formatSpeed,
  toMBps,
  toMbps,
} from './format.js';

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, INTERRUPTED: 130 });

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `\
Замер скорости скачивания по HTTP(S).

Использование:
  net-speed <url> [опции]

Опции:
  -n, --count <число>     Сколько запросов сделать (по умолчанию 10)
  -t, --timeout <сек>     Таймаут на один запрос (по умолчанию 30)
      --cache-bust        Добавлять к URL уникальный параметр, чтобы обойти кэш/CDN
      --json              Вывести результат в JSON (для скриптов и CI)
  -h, --help              Показать эту справку
  -v, --version           Показать версию

Скорость выводится в Мбит/с (мегабиты в секунду, 1 Мбит = 10^6 бит)
и дублируется в МБ/с (мегабайты в секунду, 1 МБ = 10^6 байт).

Пример:
  net-speed https://proof.ovh.net/files/10Mb.dat -n 5
`;

/**
 * @typedef {object} IO
 * @property {NodeJS.WritableStream & { isTTY?: boolean }} stdout
 * @property {NodeJS.WritableStream} stderr
 * @property {NodeJS.ProcessEnv} [env]
 * @property {AbortSignal} [signal]
 */

/**
 * Точка входа CLI. Не вызывает process.exit и не трогает глобальные потоки —
 * всё приходит через `io`, поэтому функцию легко тестировать.
 *
 * @param {string[]} argv  Аргументы без `node` и пути к скрипту.
 * @param {IO} io
 * @returns {Promise<number>} Код выхода.
 */
export async function run(argv, io) {
  const { stdout, stderr, env = {}, signal } = io;
  const paint = createPainter(Boolean(stdout.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb');

  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    stderr.write(`Ошибка: ${/** @type {Error} */ (error).message}\n\nСправка: net-speed --help\n`);
    return EXIT.USAGE;
  }

  if (options.help) {
    stdout.write(HELP);
    return EXIT.OK;
  }
  if (options.version) {
    stdout.write(`${version}\n`);
    return EXIT.OK;
  }

  const { url, count, timeoutMs, cacheBust, json } = options;

  if (!json) {
    stdout.write(`${paint.bold('Замер скорости')} ${url.href}\n`);
    stdout.write(paint.dim(`Запросов: ${count}, последовательно; таймаут: ${timeoutMs / 1000} с\n\n`));
    stdout.write(paint.dim(row(['#', 'Статус', 'Размер', 'Время', 'TTFB', 'Скорость'])) + '\n');
  }

  const results = await runBenchmark(url, {
    count,
    timeoutMs,
    cacheBust,
    signal,
    onResult: json ? undefined : (r) => stdout.write(formatResultRow(r, paint) + '\n'),
  });

  const interrupted = Boolean(signal?.aborted);
  const summary = summarize(results);

  if (json) {
    stdout.write(JSON.stringify(toJson(url, count, results, summary, interrupted), null, 2) + '\n');
  } else {
    stdout.write('\n' + formatSummary(summary, results, count, interrupted, paint));
  }

  if (interrupted) return EXIT.INTERRUPTED;
  return summary ? EXIT.OK : EXIT.FAILED;
}

/** @param {string[]} argv */
export function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      count: { type: 'string', short: 'n', default: '10' },
      timeout: { type: 'string', short: 't', default: '30' },
      'cache-bust': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.help || values.version) {
    return { help: values.help, version: values.version };
  }

  if (positionals.length === 0) throw new Error('не указан URL');
  if (positionals.length > 1) throw new Error(`ожидался один URL, получено ${positionals.length}`);

  const url = parseUrl(positionals[0]);

  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error(`--count должен быть целым числом от 1 до 1000, получено «${values.count}»`);
  }

  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`--timeout должен быть положительным числом секунд, получено «${values.timeout}»`);
  }

  return {
    url,
    count,
    timeoutMs: Math.round(timeout * 1000),
    cacheBust: values['cache-bust'],
    json: values.json,
  };
}

/** @param {string} raw */
function parseUrl(raw) {
  // Разрешаем писать адрес без схемы: example.com/file.jpg → https://example.com/file.jpg
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`некорректный URL «${raw}»`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`поддерживаются только http и https, получено «${url.protocol}»`);
  }
  return url;
}

// ───────────────────────── вывод ─────────────────────────

const COLUMNS = [4, 8, 12, 10, 10, 16];

/** @param {string[]} cells */
function row(cells) {
  return cells.map((cell, i) => cell.padEnd(COLUMNS[i])).join('').trimEnd();
}

/**
 * @param {import('./measure.js').RequestResult} r
 * @param {ReturnType<typeof createPainter>} paint
 */
function formatResultRow(r, paint) {
  if (!r.ok) {
    const head = row([String(r.index), r.status ? String(r.status) : '—']);
    return `${head.padEnd(COLUMNS[0] + COLUMNS[1])}${paint.red(`ошибка: ${r.error}`)}`;
  }
  const speed = r.durationMs > 0 ? r.bytes / (r.durationMs / 1000) : 0;
  return row([
    String(r.index),
    String(r.status),
    formatBytes(r.bytes),
    formatDuration(r.durationMs),
    formatDuration(r.ttfbMs ?? 0),
    formatSpeed(speed),
  ]);
}

/**
 * @param {import('./stats.js').Summary | null} s
 * @param {import('./measure.js').RequestResult[]} results
 * @param {number} planned
 * @param {boolean} interrupted
 * @param {ReturnType<typeof createPainter>} paint
 */
function formatSummary(s, results, planned, interrupted, paint) {
  const lines = [];
  if (interrupted) lines.push(paint.yellow(`Прервано пользователем после ${results.length} из ${planned} запросов.`));

  if (!s) {
    lines.push(paint.red('Ни один запрос не завершился успешно — скорость посчитать нельзя.'));
    return lines.join('\n') + '\n';
  }

  const label = (text) => `  ${text.padEnd(24)}`;
  lines.push(paint.bold('Итого'));
  lines.push(`${label('Успешных запросов:')}${s.succeeded} из ${s.total}`);
  lines.push(`${label('Скачано всего:')}${formatBytes(s.totalBytes)} (${formatInt(s.totalBytes)} байт)`);
  lines.push(
    `${label('Среднее время запроса:')}${formatDuration(s.avgTimeMs)}` +
      paint.dim(
        `  (медиана ${formatDuration(s.medianTimeMs)}, мин ${formatDuration(s.minTimeMs)}, ` +
          `макс ${formatDuration(s.maxTimeMs)}, σ ${formatDuration(s.stdDevTimeMs)})`,
      ),
  );
  lines.push(`${label('Среднее TTFB:')}${formatDuration(s.avgTtfbMs)}`);
  lines.push(
    `${label('Скорость скачивания:')}${paint.green(paint.bold(formatSpeed(s.bytesPerSecond)))}` +
      paint.dim(`  (${toMBps(s.bytesPerSecond).toFixed(2)} МБ/с)`),
  );

  if (s.failed > 0) {
    lines.push(paint.yellow(`\n  ${s.failed} запрос(ов) завершились ошибкой и не учтены в статистике.`));
  }
  if (s.totalBytes < 1e6) {
    lines.push(
      paint.yellow('\n  Совет: объём меньше 1 МБ — на результат сильно влияет задержка, а не канал. Возьмите файл побольше.'),
    );
  }
  return lines.join('\n') + '\n';
}

function toJson(url, count, results, summary, interrupted) {
  return {
    url: url.href,
    requested: count,
    interrupted,
    units: { bytes: 'B', time: 'ms', speed: 'Mbit/s (10^6 bit/s)' },
    summary: summary && {
      ...summary,
      mbps: toMbps(summary.bytesPerSecond),
      megabytesPerSecond: toMBps(summary.bytesPerSecond),
    },
    results,
  };
}

/** Минимальная раскраска ANSI без зависимостей. @param {boolean} enabled */
function createPainter(enabled) {
  const wrap = (open, close) => (text) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
  };
}
