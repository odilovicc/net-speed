import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mean, median, stdDev, sum, summarize } from '../src/stats.js';
import { formatBytes, formatDuration, formatInt, formatSpeed, toMBps, toMbps } from '../src/format.js';

const ok = (index, bytes, durationMs, ttfbMs) => ({ index, ok: true, status: 200, bytes, durationMs, ttfbMs });

/** Детерминированный ГПСЧ (mulberry32), чтобы тесты были воспроизводимыми. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('summarize: инварианты', () => {
  it('скорость = средний объём / среднее время (на 200 случайных наборах)', () => {
    const random = rng(42);
    for (let run = 0; run < 200; run += 1) {
      const n = 1 + Math.floor(random() * 20);
      const results = Array.from({ length: n }, (_, i) =>
        ok(i + 1, Math.floor(random() * 50e6), 1 + random() * 5000, random() * 100));
      const s = summarize(results);
      assert.ok(s);
      const expected = mean(results.map((r) => r.bytes)) / (mean(results.map((r) => r.durationMs)) / 1000);
      assert.ok(Math.abs(s.bytesPerSecond - expected) / expected < 1e-9);
      assert.ok(s.minTimeMs <= s.medianTimeMs && s.medianTimeMs <= s.maxTimeMs);
      assert.ok(s.minTimeMs <= s.avgTimeMs && s.avgTimeMs <= s.maxTimeMs);
      assert.ok(s.stdDevTimeMs >= 0);
      assert.equal(s.succeeded + s.failed, s.total);
    }
  });

  it('скорость не зависит от порядка запросов', () => {
    const results = [ok(1, 100, 10), ok(2, 5000, 300), ok(3, 42, 7)];
    const a = summarize(results);
    const b = summarize([...results].reverse());
    assert.equal(a?.bytesPerSecond, b?.bytesPerSecond);
    assert.equal(a?.medianTimeMs, b?.medianTimeMs);
  });

  it('один запрос: σ = 0, среднее = медиана = мин = макс', () => {
    const s = summarize([ok(1, 1000, 250, 20)]);
    assert.ok(s);
    assert.equal(s.stdDevTimeMs, 0);
    assert.equal(s.avgTimeMs, 250);
    assert.equal(s.medianTimeMs, 250);
    assert.equal(s.minTimeMs, 250);
    assert.equal(s.maxTimeMs, 250);
    assert.equal(s.avgTtfbMs, 20);
  });

  it('нулевое суммарное время не даёт деления на ноль', () => {
    const s = summarize([ok(1, 1000, 0)]);
    assert.equal(s?.bytesPerSecond, 0);
  });

  it('отсутствующий TTFB считается нулём', () => {
    assert.equal(summarize([ok(1, 10, 10, undefined), ok(2, 10, 10, 30)])?.avgTtfbMs, 15);
  });

  it('пустые ответы (0 байт) дают скорость 0, но считаются успешными', () => {
    const s = summarize([ok(1, 0, 10), ok(2, 0, 20)]);
    assert.equal(s?.succeeded, 2);
    assert.equal(s?.bytesPerSecond, 0);
  });

  it('не мутирует входной массив', () => {
    const results = [ok(1, 1, 30), ok(2, 1, 10), ok(3, 1, 20)];
    const snapshot = structuredClone(results);
    summarize(results);
    assert.deepEqual(results, snapshot);
  });
});

describe('вспомогательная статистика', () => {
  it('пустые массивы', () => {
    assert.equal(sum([]), 0);
    assert.equal(mean([]), 0);
    assert.equal(median([]), 0);
    assert.equal(stdDev([]), 0);
  });

  it('median не мутирует и работает с отрицательными', () => {
    const values = [3, -1, 2];
    assert.equal(median(values), 2);
    assert.deepEqual(values, [3, -1, 2]);
  });

  it('stdDev одинаковых значений равен 0', () => {
    assert.equal(stdDev([5, 5, 5, 5]), 0);
  });
});

describe('форматирование: границы единиц', () => {
  const bytesCases = [
    [0, '0 Б'],
    [999, '999 Б'],
    [1000, '1.0 КБ'],
    [999_949, '999.9 КБ'],
    [999_950, '1.00 МБ'], // раньше выводилось «1000.0 КБ»
    [999_999, '1.00 МБ'],
    [1_000_000, '1.00 МБ'],
    [999_994_999, '999.99 МБ'],
    [999_995_000, '1.00 ГБ'], // раньше выводилось «1000.00 МБ»
    [2_500_000_000, '2.50 ГБ'],
  ];
  for (const [input, expected] of bytesCases) {
    it(`formatBytes(${input}) = «${expected}»`, () => assert.equal(formatBytes(input), expected));
  }

  const durationCases = [
    [0, '0 мс'],
    [0.4, '0 мс'],
    [999.4, '999 мс'],
    [999.5, '1.00 с'], // раньше выводилось «1000 мс»
    [1000, '1.00 с'],
    [61_234, '61.23 с'],
  ];
  for (const [input, expected] of durationCases) {
    it(`formatDuration(${input}) = «${expected}»`, () => assert.equal(formatDuration(input), expected));
  }

  it('скорость: 1 МБ/с = 8 Мбит/с', () => {
    assert.equal(toMbps(1e6), 8);
    assert.equal(toMBps(1e6), 1);
    assert.equal(toMbps(0), 0);
    assert.equal(formatSpeed(0), '0.00 Мбит/с');
    assert.equal(formatSpeed(125_000_000), '1000.00 Мбит/с');
  });

  it('formatInt округляет и разбивает разряды', () => {
    // ru-RU использует неразрывный пробел (U+00A0) в качестве разделителя
    assert.equal(formatInt(52_428_800).replace(/\s/g, ' '), '52 428 800');
    assert.equal(formatInt(999.6).replace(/\s/g, ' '), '1 000');
    assert.equal(formatInt(0), '0');
  });
});
