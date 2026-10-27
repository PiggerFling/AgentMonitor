import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelativeTime, formatUsd, LOCALES, t } from '../src/renderer/i18n';
import { en } from '../src/renderer/i18n/en';
import { zhCN } from '../src/renderer/i18n/zh-CN';

function leafPaths(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  const entries = Object.entries(node as Record<string, unknown>);
  if (entries.some(([key]) => key === 'other')) return [prefix];
  return entries.flatMap(([key, value]) => leafPaths(value, prefix ? `${prefix}.${key}` : key));
}

function placeholders(node: unknown, path: string): string[] {
  const value = path.split('.').reduce<unknown>((current, part) => (current as Record<string, unknown>)[part], node);
  const text = typeof value === 'string' ? value : Object.values(value as Record<string, string>).join(' ');
  return [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
}

test('every locale defines exactly the English keys with the same placeholders', () => {
  const english = leafPaths(en).sort();
  assert.deepEqual(leafPaths(zhCN).sort(), english);
  for (const path of english) assert.deepEqual(placeholders(zhCN, path), placeholders(en, path), path);
  assert.deepEqual(LOCALES.map(locale => locale.id), ['en', 'zh-CN']);
});

test('t fills placeholders and picks plural forms per locale', () => {
  assert.equal(t('common.time.secondsAgo', { count: 5 }, 'en'), '5s ago');
  assert.equal(t('common.time.secondsAgo', { count: 5 }, 'zh-CN'), '5秒前');
  assert.equal(t('common.language', undefined, 'zh-CN'), '语言');
});

test('relative times and dollar amounts follow the locale', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeTime(undefined, now, 'en'), 'unknown');
  assert.equal(formatRelativeTime(now - 2000, now, 'en'), 'just now');
  assert.equal(formatRelativeTime(now - 3 * 60_000, now, 'zh-CN'), '3分钟前');
  assert.equal(formatUsd(1.5, { minimumFractionDigits: 2 }, 'en'), '$1.50');
  assert.equal(formatUsd(1.5, { minimumFractionDigits: 2 }, 'zh-CN'), '$1.50');
});
