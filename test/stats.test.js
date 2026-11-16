import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mean, median, stdDev, summarize } from '../src/stats.js';
import { formatBytes, formatDuration, formatSpeed, toMBps, toMbps } from '../src/format.js';

const ok = (index, bytes, durationMs, ttfbMs = 10) => ({ index, ok: true, status: 200, bytes, durationMs, ttfbMs });

describe('summarize', () => {
  it('считает объём, среднее время и скорость', () => {
    const s = summarize([ok(1, 1_000_000, 1000), ok(2, 1_000_000, 3000)]);
    assert.ok(s);
    assert.equal(s.totalBytes, 2_000_000);
    assert.equal(s.totalTimeMs, 4000);
    assert.equal(s.avgTimeMs, 2000);
    assert.equal(s.minTimeMs, 1000);
    assert.equal(s.maxTimeMs, 3000);
    // 2 МБ за 4 с = 0.5 МБ/с, а не среднее скоростей (1 + 0.333) / 2 = 0.667
    assert.equal(s.bytesPerSecond, 500_000);
  });

  it('не учитывает неудачные запросы', () => {
    const s = summarize([ok(1, 500, 100), { index: 2, ok: false, bytes: 50, durationMs: 9999, error: 'x' }]);
    assert.ok(s);
    assert.equal(s.total, 2);
    assert.equal(s.succeeded, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.totalBytes, 500);
    assert.equal(s.avgTimeMs, 100);
  });

  it('возвращает null, если успешных запросов нет', () => {
    assert.equal(summarize([]), null);
    assert.equal(summarize([{ index: 1, ok: false, bytes: 0, durationMs: 1 }]), null);
  });
});

describe('статистические функции', () => {
  it('mean / median / stdDev', () => {
    assert.equal(mean([1, 2, 3, 4]), 2.5);
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(stdDev([2, 4, 4, 4, 5, 5, 7, 9]).toFixed(4), '2.1381');
    assert.equal(stdDev([42]), 0);
  });
});

describe('форматирование', () => {
  it('переводит байты/с в Мбит/с и МБ/с (десятичные единицы)', () => {
    assert.equal(toMbps(1_250_000), 10);
    assert.equal(toMBps(1_250_000), 1.25);
    assert.equal(formatSpeed(1_250_000), '10.00 Мбит/с');
  });

  it('форматирует размер и время', () => {
    assert.equal(formatBytes(512), '512 Б');
    assert.equal(formatBytes(1500), '1.5 КБ');
    assert.equal(formatBytes(10_000_000), '10.00 МБ');
    assert.equal(formatDuration(42.4), '42 мс');
    assert.equal(formatDuration(1234), '1.23 с');
  });
});
