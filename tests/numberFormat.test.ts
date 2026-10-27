import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCount, formatExactCount, readNumberFormat } from '../src/renderer/numberFormat';

test('compact counts use K, M and B with at most one decimal in every language', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    assert.equal(formatCount(0, 'compact', locale), '0');
    assert.equal(formatCount(999, 'compact', locale), '999');
    assert.equal(formatCount(1000, 'compact', locale), '1K');
    assert.equal(formatCount(1050, 'compact', locale), '1.1K');
    assert.equal(formatCount(724_600, 'compact', locale), '724.6K');
    assert.equal(formatCount(97_574_015, 'compact', locale), '97.6M');
    assert.equal(formatCount(1_234_567_890, 'compact', locale), '1.2B');
  }
  assert.equal(formatCount(195_000, 'compact', 'zh-CN'), '195K');
});

test('compact counts move to the next unit when rounding reaches 1000', () => {
  assert.equal(formatCount(999_960, 'compact', 'en'), '1M');
  assert.equal(formatCount(999_949, 'compact', 'en'), '999.9K');
  assert.equal(formatCount(999_960_000, 'compact', 'en'), '1B');
  assert.equal(formatCount(2_500_000_000_000, 'compact', 'en'), '2,500B');
});

test('small values stay as they are, fractions keep one decimal', () => {
  assert.equal(formatCount(12.345, 'compact', 'en'), '12.3');
  assert.equal(formatCount(12.345, 'full', 'en'), '12.3');
  assert.equal(formatCount(-1500, 'compact', 'en'), '-1.5K');
});

test('full counts use grouped digits', () => {
  assert.equal(formatCount(97_574_015, 'full', 'en'), '97,574,015');
  assert.equal(formatCount(97_574_015, 'full', 'zh-CN'), '97,574,015');
  assert.equal(formatCount(1234.6, 'full', 'en'), '1,235');
  assert.equal(formatExactCount(724_600, 'en'), '724,600');
});

test('the stored number format defaults to compact', () => {
  assert.equal(readNumberFormat({ getItem: () => null }), 'compact');
  assert.equal(readNumberFormat({ getItem: () => 'full' }), 'full');
  assert.equal(readNumberFormat({ getItem: () => 'bogus' }), 'compact');
  assert.equal(readNumberFormat({ getItem: () => { throw new Error('denied'); } }), 'compact');
});
