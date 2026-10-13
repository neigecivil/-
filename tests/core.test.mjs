import test from 'node:test';
import assert from 'node:assert/strict';

import { can, canSee, canDelete, isRole } from '../src/core/roles.js';
import { checkPassword, isStrong, MIN_LENGTH } from '../src/core/password.js';
import { generateCode, normalizeCode, formatCode, checkInvite } from '../src/core/invite.js';
import { checkLoginAllowed, MAX_FAILURES, WINDOW_MS } from '../src/core/loginGuard.js';

/* ── 角色与权限 ─────────────────────────────────────────── */

test('角色权限', async (t) => {
  await t.test('只有这三种角色算合法', () => {
    assert.equal(isRole('admin'), true);
    assert.equal(isRole('member'), true);
    assert.equal(isRole('guest'), true);
    assert.equal(isRole('root'), false);
    assert.equal(isRole(''), false);
  });

  await t.test('游客不能上传', () => {
    assert.equal(can('guest', 'upload'), false);
    assert.equal(can('member', 'upload'), true);
    assert.equal(can('admin', 'upload'), true);
  });

  await t.test('只有管理员能建邀请码和管理用户', () => {
    assert.equal(can('admin', 'createInvite'), true);
    assert.equal(can('admin', 'manageUsers'), true);
    assert.equal(can('member', 'createInvite'), false);
    assert.equal(can('member', 'manageUsers'), false);
    assert.equal(can('guest', 'createInvite'), false);
  });

  await t.test('没登录看不到「登录可见」的资源，有账号就能看', () => {
    const open = { visibility: 'public' };
    const internal = { visibility: 'members' };
    assert.equal(canSee('anonymous', open), true);
    assert.equal(canSee('anonymous', internal), false);
    assert.equal(canSee('guest', internal), true);
    assert.equal(canSee('member', internal), true);
    assert.equal(canSee('admin', internal), true);
  });

  await t.test('旧数据没有 visibility 字段时按公开处理', () => {
    assert.equal(canSee('guest', { id: 'r1' }), true);
  });

  await t.test('资源不存在时谁都看不到', () => {
    assert.equal(canSee('guest', null), false);
    assert.equal(canSee('admin', undefined), false);
  });
});

test('删除权限', async (t) => {
  const alice = { id: 'u_a' };
  const bob = { id: 'u_b' };

  await t.test('本人可以删自己的', () => {
    assert.equal(canDelete('member', alice, { ownerId: 'u_a' }), true);
  });

  await t.test('成员删不了别人的', () => {
    assert.equal(canDelete('member', bob, { ownerId: 'u_a' }), false);
  });

  await t.test('管理员可以删任何人的', () => {
    assert.equal(canDelete('admin', bob, { ownerId: 'u_a' }), true);
  });

  await t.test('游客删不了任何东西', () => {
    assert.equal(canDelete('guest', alice, { ownerId: 'u_a' }), false);
  });
});

/* ── 口令规则 ───────────────────────────────────────────── */

test('口令规则', async (t) => {
  await t.test('太短会被拒，并说明长度要求', () => {
    const problems = checkPassword('abc123');
    assert.equal(problems.length > 0, true);
    assert.match(problems.join(' '), new RegExp(String(MIN_LENGTH)));
  });

  await t.test('常见弱口令会被拒', () => {
    assert.equal(isStrong('password'), false);
    assert.equal(isStrong('1234567890'), false);
  });

  await t.test('纯数字会被拒', () => {
    const problems = checkPassword('8392017456');
    assert.match(problems.join(' '), /数字/);
  });

  await t.test('包含昵称会被拒', () => {
    const problems = checkPassword('alice2026secure', { username: 'alice' });
    assert.match(problems.join(' '), /昵称/);
  });

  await t.test('8 位能过，7 位不行——这是定好的下限', () => {
    assert.equal(MIN_LENGTH, 8);
    assert.equal('harbor-88'.length >= MIN_LENGTH, true);
    assert.equal(isStrong('harbor-88'), true);
    assert.equal('harbo-8'.length, 7);
    assert.equal(checkPassword('harbo-8').length > 0, true);
  });

  await t.test('够长且不含明显问题的能通过', () => {
    assert.equal(isStrong('harbor-lantern-77', { username: 'alice' }), true);
  });

  await t.test('一次列出全部问题，而不是只报第一个', () => {
    const problems = checkPassword('123', { username: '123' });
    assert.equal(problems.length >= 2, true);
  });
});

/* ── 邀请码 ─────────────────────────────────────────────── */

test('邀请码', async (t) => {
  await t.test('生成出来的长度固定', () => {
    const code = generateCode(new Array(10).fill(7));
    assert.equal(code.length, 10);
  });

  await t.test('同样的随机输入生成同样的码，方便测试', () => {
    const bytes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    assert.equal(generateCode(bytes), '23456789AB');
  });

  await t.test('不含容易看错的字符', () => {
    const sample = generateCode(new Array(400).fill(0).map((_, i) => i));
    assert.equal(/[0O1IL]/.test(sample), false);
  });

  await t.test('用户输入小写、空格、横线都能认出来', () => {
    assert.equal(normalizeCode('ab cd-ef gh'), 'ABCDEFGH');
    assert.equal(normalizeCode('  abcde fghij '), 'ABCDEFGHIJ');
  });

  await t.test('展示时每五位加一个横线', () => {
    assert.equal(formatCode('ABCDEFGHIJ'), 'ABCDE-FGHIJ');
    assert.equal(formatCode('abcde-fghij'), 'ABCDE-FGHIJ');
  });

  await t.test('正常邀请码可用', () => {
    const r = checkInvite({ role: 'member', maxUses: 1, usedCount: 0 }, Date.now());
    assert.equal(r.ok, true);
  });

  await t.test('用完的邀请码会被拒', () => {
    const r = checkInvite({ role: 'member', maxUses: 2, usedCount: 2 }, Date.now());
    assert.equal(r.ok, false);
    assert.match(r.reason, /用完/);
  });

  await t.test('过期的邀请码会被拒', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const r = checkInvite({ role: 'member', maxUses: 1, usedCount: 0, expiresAt: past }, Date.now());
    assert.equal(r.ok, false);
    assert.match(r.reason, /过期/);
  });

  await t.test('作废的邀请码会被拒', () => {
    const r = checkInvite({ role: 'member', maxUses: 1, usedCount: 0, revokedAt: new Date().toISOString() }, Date.now());
    assert.equal(r.ok, false);
  });

  await t.test('不存在的邀请码会被拒', () => {
    assert.equal(checkInvite(null, Date.now()).ok, false);
  });
});

/* ── 登录失败限制 ───────────────────────────────────────── */

test('登录失败限制', async (t) => {
  const now = 1_800_000_000_000;

  await t.test('没失败过时可以登录', () => {
    const r = checkLoginAllowed([], now);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, MAX_FAILURES);
  });

  await t.test('失败到上限就锁住', () => {
    const failures = new Array(MAX_FAILURES).fill(now - 1000);
    const r = checkLoginAllowed(failures, now);
    assert.equal(r.allowed, false);
    assert.equal(r.retryAfterMs > 0, true);
    assert.match(String(r.minutes), /^\d+$/);
  });

  await t.test('差一次到上限时仍然放行', () => {
    const failures = new Array(MAX_FAILURES - 1).fill(now - 1000);
    const r = checkLoginAllowed(failures, now);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 1);
  });

  await t.test('窗口之外的旧失败不计入', () => {
    const old = new Array(MAX_FAILURES).fill(now - WINDOW_MS - 1000);
    const r = checkLoginAllowed(old, now);
    assert.equal(r.allowed, true);
  });

  await t.test('密码对了也不会受影响——判定只看失败记录', () => {
    const mixed = [now - 60000, now - 120000];
    assert.equal(checkLoginAllowed(mixed, now).allowed, true);
  });
});
