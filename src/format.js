// Все единицы десятичные (СИ), как у провайдеров и speedtest.net:
// 1 МБ = 1 000 000 байт, 1 Мбит/с = 1 000 000 бит в секунду.

/** @param {number} bytesPerSecond */
export const toMbps = (bytesPerSecond) => (bytesPerSecond * 8) / 1e6;

/** @param {number} bytesPerSecond */
export const toMBps = (bytesPerSecond) => bytesPerSecond / 1e6;

// Пороги сдвинуты на половину последнего разряда: единица выбирается с учётом
// округления, чтобы не получить «1000.0 КБ» вместо «1.00 МБ».

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1e3) return `${bytes} Б`;
  if (bytes < 999.95e3) return `${(bytes / 1e3).toFixed(1)} КБ`;
  if (bytes < 999.995e6) return `${(bytes / 1e6).toFixed(2)} МБ`;
  return `${(bytes / 1e9).toFixed(2)} ГБ`;
}

/** @param {number} ms */
export function formatDuration(ms) {
  if (ms < 999.5) return `${Math.round(ms)} мс`;
  return `${(ms / 1000).toFixed(2)} с`;
}

/** @param {number} bytesPerSecond */
export function formatSpeed(bytesPerSecond) {
  return `${toMbps(bytesPerSecond).toFixed(2)} Мбит/с`;
}

/** Целое число с разделителем разрядов: 52428800 → «52 428 800». @param {number} n */
export const formatInt = (n) => Math.round(n).toLocaleString('ru-RU');
