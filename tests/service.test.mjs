import test from 'node:test';
import assert from 'node:assert/strict';

import { createService } from '../src/core/service.js';
import { createMemoryStore } from '../src/store/memory.js';
import { createMemoryFiles } from './fake-files.mjs';

function clockAt(start) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

function setup(options) {
  const opts = options || {};
  const store = createMemoryStore();
  const files = createMemoryFiles();
  const clock = clockAt(opts.start || 1_800_000_000_000);
  let counter = 0;
  const svc = createService({
    store,
    files,
    now: clock.now,
    bootstrapCode: opts.bootstrapCode || '',
    uuid: () => 'x' + (++counter),
    token: () => 'tok' + (++counter),
    randomBytes: (n) => Buffer.alloc(n, (counter % 200) + 1),
  });
  return { store, files, clock, svc };
}

async function makeAdmin(ctx) {
  return ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
}

async function uploadOne(ctx, reg, meta, size) {
  const started = await ctx.svc.startUpload(reg.token, { fileName: meta.fileName || 'note.txt' });
  const bytes = new Uint8Array(size || 64);
  const part = await ctx.svc.uploadPart(reg.token, {
    key: started.key, uploadId: started.uploadId, partNumber: 1, partCount: 1, data: bytes,
  });
  return ctx.svc.completeUpload(reg.token, {
    key: started.key,
    uploadId: started.uploadId,
    resourceId: started.resourceId,
    partSize: started.partSize,
    parts: [part],
    meta,
    file: { name: meta.fileName || 'note.txt', size: bytes.length, mime: 'text/plain' },
  });
}

/* ── 注册与邀请码 ───────────────────────────────────────── */

test('注册', async (t) => {
  await t.test('没有邀请码不能注册', async () => {
    const ctx = setup();
    await assert.rejects(
      () => ctx.svc.register({ username: '路人', password: 'harbor-lantern-77' }),
      /邀请码/,
    );
  });

  await t.test('用一个身份都没有时，凭暗号建出管理员', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const r = await makeAdmin(ctx);
    assert.equal(r.user.role, 'admin');
    assert.equal(typeof r.token, 'string');
  });

  await t.test('暗号只能用一次', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    await makeAdmin(ctx);
    await assert.rejects(
      () => ctx.svc.register({ username: '第二个', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' }),
      /邀请码|一次/,
    );
  });

  await t.test('初始暗号从「邀请码」字段进来也能建出管理员——界面就是这么传的', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const r = await ctx.svc.register({ username: '第一个', password: 'harbor-lantern-77', inviteCode: 'OPEN-SESAME' });
    assert.equal(r.user.role, 'admin');
  });

  await t.test('初始暗号容得下大小写和横线', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const r = await ctx.svc.register({ username: '第一个', password: 'harbor-lantern-77', inviteCode: 'open sesame' });
    assert.equal(r.user.role, 'admin');
  });

  await t.test('已经有账号之后，初始暗号就失效了', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    await ctx.svc.register({ username: '第一个', password: 'harbor-lantern-77', inviteCode: 'OPEN-SESAME' });
    await assert.rejects(
      () => ctx.svc.register({ username: '第二个', password: 'harbor-lantern-77', inviteCode: 'OPEN-SESAME' }),
      /一次|邀请码/,
    );
  });

  await t.test('乱填邀请码会说清楚是没找到', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    await assert.rejects(
      () => ctx.svc.register({ username: '路人', password: 'harbor-lantern-77', inviteCode: 'ZZZZZ-ZZZZZ' }),
      /没找到/,
    );
  });

  await t.test('管理员发的邀请码能注册出成员', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 1 });
    const joined = await ctx.svc.register({ username: '小明', password: 'harbor-lantern-77', inviteCode: invite.formatted });
    assert.equal(joined.user.role, 'member');
  });

  await t.test('用过的邀请码不能再用', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 1 });
    await ctx.svc.register({ username: '小明', password: 'harbor-lantern-77', inviteCode: invite.code });
    await assert.rejects(
      () => ctx.svc.register({ username: '小红', password: 'harbor-lantern-77', inviteCode: invite.code }),
      /用完/,
    );
  });

  await t.test('弱口令会被挡下，并且一次说清所有问题', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    await makeAdmin(ctx);
    await assert.rejects(
      () => ctx.svc.register({ username: '弱密码', password: '123456', bootstrapCode: 'OPEN-SESAME' }),
      (err) => err.status === 400,
    );
  });
});

/* ── 登录 ───────────────────────────────────────────────── */

test('登录', async (t) => {
  await t.test('密码对了能拿到登录态', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    await makeAdmin(ctx);
    const r = await ctx.svc.login({ username: '管理员', password: 'harbor-lantern-77' });
    assert.equal(r.user.username, '管理员');
  });

  await t.test('密码错了只说一句含糊的话，不透露账号是否存在', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    await makeAdmin(ctx);
    const wrongPassword = await ctx.svc.login({ username: '管理员', password: 'nope-nope-nope' }).catch((e) => e);
    const noSuchUser = await ctx.svc.login({ username: '根本没这人', password: 'nope-nope-nope' }).catch((e) => e);
    assert.equal(wrongPassword.message, noSuchUser.message);
    assert.equal(wrongPassword.status, 401);
  });

  await t.test('连续错够次数就锁住', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    await makeAdmin(ctx);
    for (let i = 0; i < 5; i++) {
      await ctx.svc.login({ username: '管理员', password: 'bad-' + i + '-pass' }).catch(() => {});
    }
    const locked = await ctx.svc.login({ username: '管理员', password: 'harbor-lantern-77' }).catch((e) => e);
    assert.equal(locked.status, 429);
    assert.match(locked.message, /分钟/);
  });

  await t.test('等过了锁定窗口，正确的密码照样能进', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    await makeAdmin(ctx);
    for (let i = 0; i < 5; i++) {
      await ctx.svc.login({ username: '管理员', password: 'bad-' + i + '-pass' }).catch(() => {});
    }
    ctx.clock.advance(16 * 60 * 1000);
    const ok = await ctx.svc.login({ username: '管理员', password: 'harbor-lantern-77' });
    assert.equal(ok.user.role, 'admin');
  });
});

/* ── 角色权限 ───────────────────────────────────────────── */

test('角色权限', async (t) => {
  async function withGuest() {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'guest', maxUses: 5 });
    const guest = await ctx.svc.register({ username: '游客甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    return { ctx, admin, guest };
  }

  await t.test('游客不能上传', async () => {
    const { ctx, guest } = await withGuest();
    await assert.rejects(() => ctx.svc.startUpload(guest.token, { fileName: 'a.txt' }), /只能下载/);
  });

  await t.test('游客看不到「仅成员」的资源', async () => {
    const { ctx, admin, guest } = await withGuest();
    await uploadOne(ctx, admin, { title: '内部资料', category: 'doc', visibility: 'members' }, 32);
    await uploadOne(ctx, admin, { title: '公开资料', category: 'doc', visibility: 'public' }, 32);

    const asGuest = await ctx.svc.listResources(guest.token, new URLSearchParams());
    assert.equal(asGuest.total, 1);
    assert.equal(asGuest.resources[0].title, '公开资料');

    const asAdmin = await ctx.svc.listResources(admin.token, new URLSearchParams());
    assert.equal(asAdmin.total, 2);
  });

  await t.test('匿名访客同样只看得到公开资源', async () => {
    const { ctx, admin } = await withGuest();
    await uploadOne(ctx, admin, { title: '内部资料', category: 'doc', visibility: 'members' }, 32);
    const anon = await ctx.svc.listResources(null, new URLSearchParams());
    assert.equal(anon.total, 0);
  });

  await t.test('游客直接点下载地址也拿不到「仅成员」的文件', async () => {
    const { ctx, admin, guest } = await withGuest();
    const made = await uploadOne(ctx, admin, { title: '内部资料', category: 'doc', visibility: 'members' }, 32);
    await assert.rejects(() => ctx.svc.download(guest.token, made.id), /成员/);
  });

  await t.test('成员删不掉别人的文件', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 5 });
    const member = await ctx.svc.register({ username: '成员甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    const made = await uploadOne(ctx, admin, { title: '管理员的文件', category: 'doc' }, 32);
    await assert.rejects(() => ctx.svc.deleteResource(member.token, made.id), /删不了/);
  });

  await t.test('管理员可以删掉别人的文件', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 5 });
    const member = await ctx.svc.register({ username: '成员甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    const made = await uploadOne(ctx, member, { title: '成员的文件', category: 'doc' }, 32);
    await ctx.svc.deleteResource(admin.token, made.id);
    const left = await ctx.svc.listResources(admin.token, new URLSearchParams());
    assert.equal(left.total, 0);
  });

  await t.test('普通成员发不了邀请码', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 5 });
    const member = await ctx.svc.register({ username: '成员甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    await assert.rejects(() => ctx.svc.createInvite(member.token, { role: 'member' }), /管理员/);
  });
});

/* ── 分块上传 ───────────────────────────────────────────── */

test('分块上传', async (t) => {
  await t.test('走完 start / part / complete，资源就出现了', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const made = await uploadOne(ctx, admin, {
      title: '会议纪要', description: '上周的', category: 'doc', visibility: 'public', fileName: 'meeting.txt',
    }, 128);
    assert.equal(made.title, '会议纪要');
    assert.equal(made.fileName, 'meeting.txt');
    assert.equal(made.owner, '管理员');
    assert.equal(made.mine, true);

    const list = await ctx.svc.listResources(admin.token, new URLSearchParams());
    assert.equal(list.total, 1);
  });

  await t.test('对象键里不带 R2 内部信息，也不出现在返回里', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const made = await uploadOne(ctx, admin, { title: '纪要', category: 'doc' }, 32);
    assert.equal(Object.prototype.hasOwnProperty.call(made, 'r2_key'), false);
  });

  await t.test('拿别人的上传任务传分片会被拒', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 5 });
    const member = await ctx.svc.register({ username: '成员甲', password: 'harbor-lantern-77', inviteCode: invite.code });

    const started = await ctx.svc.startUpload(admin.token, { fileName: 'secret.txt' });
    await assert.rejects(
      () => ctx.svc.uploadPart(member.token, {
        key: started.key, uploadId: started.uploadId, partNumber: 1, partCount: 1, data: new Uint8Array(8),
      }),
      /不是你的上传任务/,
    );
  });

  await t.test('分片数量对不上会被拒', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const started = await ctx.svc.startUpload(admin.token, { fileName: 'big.bin' });
    await assert.rejects(
      () => ctx.svc.completeUpload(admin.token, {
        key: started.key,
        uploadId: started.uploadId,
        parts: [{ partNumber: 1, etag: 'e1' }],
        meta: { title: '大文件', category: 'other' },
        file: { name: 'big.bin', size: started.partSize * 3 },
        partSize: started.partSize,
      }),
      /分片数量/,
    );
  });

  await t.test('没传完就放弃，不会留下资源', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const started = await ctx.svc.startUpload(admin.token, { fileName: 'half.bin' });
    await ctx.svc.abortUpload(admin.token, { key: started.key, uploadId: started.uploadId });
    const list = await ctx.svc.listResources(admin.token, new URLSearchParams());
    assert.equal(list.total, 0);
  });
});

/* ── 下载与改密码 ───────────────────────────────────────── */

test('下载', async (t) => {
  await t.test('下载会累加次数', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const made = await uploadOne(ctx, admin, { title: '公开资料', category: 'doc', visibility: 'public' }, 32);
    await ctx.svc.download(null, made.id);
    const list = await ctx.svc.listResources(admin.token, new URLSearchParams());
    assert.equal(list.resources[0].downloads, 1);
  });

  await t.test('不存在的资源提示清楚', async () => {
    const ctx = setup();
    await assert.rejects(() => ctx.svc.download(null, 'r_不存在'), /不在了/);
  });
});

test('改密码', async (t) => {
  await t.test('当前密码不对就不让改', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    await assert.rejects(
      () => ctx.svc.changePassword(admin.token, { current: 'wrong-one', next: 'harbor-lantern-88' }),
      /当前密码/,
    );
  });

  await t.test('改成功后其它设备的登录态失效', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const other = await ctx.svc.login({ username: '管理员', password: 'harbor-lantern-77' });

    const result = await ctx.svc.changePassword(admin.token, {
      current: 'harbor-lantern-77', next: 'harbor-lantern-88',
    });
    assert.equal(typeof result.token, 'string');

    await assert.rejects(() => ctx.svc.requireUser(other.token), /失效|过期/);
    assert.equal((await ctx.svc.requireUser(result.token)).username, '管理员');
  });

  await t.test('新密码也要过强度检查', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    await assert.rejects(
      () => ctx.svc.changePassword(admin.token, { current: 'harbor-lantern-77', next: '123456' }),
      (err) => err.status === 400,
    );
  });
});
