/** @typedef {import('./measure.js').RequestResult} RequestResult */

/**
 * @typedef {object} Summary
 * @property {number} total          Сколько запросов сделано.
 * @property {number} succeeded      Сколько из них успешны.
 * @property {number} failed
 * @property {number} totalBytes     Суммарный объём тел успешных ответов, байт.
 * @property {number} totalTimeMs    Суммарное время успешных запросов, мс.
 * @property {number} avgTimeMs      Среднее время запроса, мс.
 * @property {number} medianTimeMs
 * @property {number} minTimeMs
 * @property {number} maxTimeMs
 * @property {number} stdDevTimeMs
 * @property {number} avgTtfbMs      Среднее время до первого байта (заголовков), мс.
 * @property {number} bytesPerSecond Скорость скачивания: totalBytes / totalTime.
 */

/**
 * Считает итоговую статистику по успешным запросам.
 * Скорость = весь объём / всё время скачивания. Это то же самое,
 * что «средний объём / среднее время», и, в отличие от среднего
 * арифметического скоростей, не завышается редкими быстрыми запросами.
 *
 * @param {RequestResult[]} results
 * @returns {Summary | null}  null, если ни один запрос не удался.
 */
export function summarize(results) {
  const ok = results.filter((r) => r.ok);
  if (ok.length === 0) return null;

  const times = ok.map((r) => r.durationMs);
  const totalBytes = sum(ok.map((r) => r.bytes));
  const totalTimeMs = sum(times);

  return {
    total: results.length,
    succeeded: ok.length,
    failed: results.length - ok.length,
    totalBytes,
    totalTimeMs,
    avgTimeMs: mean(times),
    medianTimeMs: median(times),
    minTimeMs: Math.min(...times),
    maxTimeMs: Math.max(...times),
    stdDevTimeMs: stdDev(times),
    avgTtfbMs: mean(ok.map((r) => r.ttfbMs ?? 0)),
    bytesPerSecond: totalTimeMs > 0 ? totalBytes / (totalTimeMs / 1000) : 0,
  };
}

/** @param {number[]} values */
export const sum = (values) => values.reduce((acc, v) => acc + v, 0);

/** @param {number[]} values */
export const mean = (values) => (values.length ? sum(values) / values.length : 0);

/** @param {number[]} values */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Выборочное стандартное отклонение. @param {number[]} values */
export function stdDev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(sum(values.map((v) => (v - avg) ** 2)) / (values.length - 1));
}
