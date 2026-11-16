import { performance } from 'node:perf_hooks';

/** Ошибка ответа сервера с не-2xx статусом. */
export class HttpError extends Error {
  /** @param {number} status @param {string} statusText */
  constructor(status, statusText) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * @typedef {object} RequestResult
 * @property {number} index        Порядковый номер запроса (с 1).
 * @property {boolean} ok          Запрос завершился успешно и тело дочитано до конца.
 * @property {number} [status]     HTTP-статус ответа.
 * @property {number} bytes        Сколько байт тела получено.
 * @property {number} durationMs   Полное время: от отправки до последнего байта.
 * @property {number} [ttfbMs]     Время до получения заголовков ответа.
 * @property {string} [error]      Текст ошибки, если запрос не удался.
 */

const DEFAULT_HEADERS = {
  // Просим несжатый ответ: иначе fetch распакует gzip/br и мы посчитаем
  // распакованные байты, а не то, что реально прошло по сети.
  'accept-encoding': 'identity',
  // Просим промежуточные кэши не отдавать сохранённую копию.
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'user-agent': 'net-speed-cli',
};

/**
 * Делает один GET-запрос и дочитывает тело до конца, считая байты.
 * Тело не буферизуется в память — подходит для файлов любого размера.
 *
 * @param {URL | string} url
 * @param {object} [options]
 * @param {number} [options.index=1]
 * @param {number} [options.timeoutMs=30000]  Таймаут на весь запрос, включая тело.
 * @param {AbortSignal} [options.signal]      Внешняя отмена (например, Ctrl+C).
 * @param {Record<string, string>} [options.headers]
 * @returns {Promise<RequestResult>}
 */
export async function measureRequest(url, options = {}) {
  const { index = 1, timeoutMs = 30_000, signal, headers = {} } = options;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);

  let bytes = 0;
  let status;
  let ttfbMs;
  const start = performance.now();

  try {
    const response = await fetch(url, {
      headers: { ...DEFAULT_HEADERS, ...headers },
      redirect: 'follow',
      signal: AbortSignal.any(signals),
    });
    ttfbMs = performance.now() - start;
    status = response.status;

    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, response.statusText);
    }

    if (response.body) {
      for await (const chunk of response.body) bytes += chunk.byteLength;
    }

    return { index, ok: true, status, bytes, durationMs: performance.now() - start, ttfbMs };
  } catch (error) {
    return {
      index,
      ok: false,
      status,
      bytes,
      durationMs: performance.now() - start,
      ttfbMs,
      error: describeError(error, timeoutMs),
    };
  }
}

/**
 * Делает `count` запросов строго последовательно.
 *
 * @param {URL | string} url
 * @param {object} [options]
 * @param {number} [options.count=10]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.cacheBust=false]  Добавлять уникальный query-параметр к каждому запросу.
 * @param {(result: RequestResult) => void} [options.onResult]  Колбэк после каждого запроса.
 * @returns {Promise<RequestResult[]>}
 */
export async function runBenchmark(url, options = {}) {
  const { count = 10, timeoutMs, signal, cacheBust = false, onResult } = options;
  /** @type {RequestResult[]} */
  const results = [];

  for (let index = 1; index <= count; index += 1) {
    if (signal?.aborted) break;
    const target = cacheBust ? withCacheBuster(url, index) : url;
    const result = await measureRequest(target, { index, timeoutMs, signal });
    results.push(result);
    onResult?.(result);
  }

  return results;
}

/** @param {URL | string} url @param {number} index */
export function withCacheBuster(url, index) {
  const copy = new URL(url);
  copy.searchParams.set('_nocache', `${Date.now()}-${index}`);
  return copy;
}

/** Превращает ошибку fetch в короткое понятное сообщение. */
function describeError(error, timeoutMs) {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError') return `таймаут ${timeoutMs} мс`;
  if (error.name === 'AbortError') return 'прервано';
  // fetch прячет настоящую причину (ENOTFOUND, ECONNREFUSED...) в error.cause.
  const cause = /** @type {any} */ (error).cause;
  if (cause?.code) {
    return cause.message?.includes(cause.code) ? cause.message : `${cause.code}: ${cause.message ?? ''}`.trim();
  }
  if (cause?.message) return `${error.message}: ${cause.message}`;
  return error.message;
}
