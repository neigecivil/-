import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateUsage, canStore, GUARD_DEFAULTS } from '../src/core/guard.js';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/* 统一用这套参数，模拟 Cloudflare 的免费额度 */
const OPTIONS = { limitBytes: 10 * GB, reserveBytes: 200 * MB, warnPercent: 80 };

test('用量保护', async (t) => {
  await t.test('刚开张时一切正常', () => {
    const u = evaluateUsage(0, OPTIONS);
    assert.equal(u.level, 'ok');
    assert.equal(u.blocked, false);
    assert.equal(u.percent, 0);
  });

  await t.test('预留的 200MB 要从可用额度里扣掉', () => {
    const u = evaluateUsage(0, OPTIONS);
    assert.equal(u.effectiveCapBytes, 10 * GB - 200 * MB);
  });

  await t.test('用到八成就进入警告档，但还能继续传', () => {
    const u = evaluateUsage(Math.floor((10 * GB - 200 * MB) * 0.85), OPTIONS);
    assert.equal(u.level, 'warn');
    assert.equal(u.warning, true);
    assert.equal(u.blocked, false);
  });

  await t.test('没到八成就是正常', () => {
    const u = evaluateUsage(Math.floor((10 * GB - 200 * MB) * 0.5), OPTIONS);
    assert.equal(u.level, 'ok');
  });

  await t.test('顶到上限就封锁', () => {
    const u = evaluateUsage(10 * GB - 200 * MB, OPTIONS);
    assert.equal(u.level, 'blocked');
    assert.equal(u.blocked, true);
    assert.equal(u.remainingBytes, 0);
  });

  await t.test('超过上限也照样封锁，百分比不会超过 100', () => {
    const u = evaluateUsage(12 * GB, OPTIONS);
    assert.equal(u.blocked, true);
    assert.equal(u.percent, 100);
  });

  await t.test('再放一个文件之前会算一下放不放得下', () => {
    const room = evaluateUsage(10 * GB - 200 * MB - 500 * MB, OPTIONS);
    assert.equal(canStore(room, 400 * MB), true);
    assert.equal(canStore(room, 600 * MB), false);
  });

  await t.test('恰好用满算放得下，多一个字节就不行', () => {
    const u = evaluateUsage(10 * GB - 200 * MB - 100, OPTIONS);
    assert.equal(canStore(u, 100), true);
    assert.equal(canStore(u, 101), false);
  });

  await t.test('参数缺失时用默认值，不会算出 NaN', () => {
    const u = evaluateUsage(0, {});
    assert.equal(u.limitBytes, GUARD_DEFAULTS.limitBytes);
    assert.equal(u.reserveBytes, GUARD_DEFAULTS.reserveBytes);
    assert.equal(Number.isNaN(u.percent), false);
  });

  await t.test('传入乱七八糟的用量也不会崩', () => {
    assert.equal(evaluateUsage(-5, OPTIONS).usedBytes, 0);
    assert.equal(evaluateUsage('abc', OPTIONS).usedBytes, 0);
    assert.equal(evaluateUsage(null, OPTIONS).usedBytes, 0);
  });

  await t.test('预留比总额度还大时，可用额度按 0 算并直接封锁', () => {
    const u = evaluateUsage(0, { limitBytes: 100, reserveBytes: 500, warnPercent: 80 });
    assert.equal(u.effectiveCapBytes, 0);
    assert.equal(u.blocked, true);
  });
});
