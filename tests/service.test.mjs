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
    storageLimitBytes: opts.storageLimitBytes,
    storageReserveBytes: opts.storageReserveBytes,
    storageWarnPercent: opts.storageWarnPercent,
    blockDownloadsWhenFull: opts.blockDownloadsWhenFull,
    userQuotaBytes: opts.userQuotaBytes,
    userQuotaWarnPercent: opts.userQuotaWarnPercent,
  });
  return { store, files, clock, svc };
}

async function makeAdmin(ctx) {
  return ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
}

async function uploadOne(ctx, reg, meta, size) {
  const started = await ctx.svc.startUpload(reg.token, { fileName: meta.fileName || 'note.txt', fileSize: size || 64 });
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

  await t.test('有账号就能看内部资料，没登录的只能看公开的', async () => {
    const { ctx, admin, guest } = await withGuest();
    await uploadOne(ctx, admin, { title: '内部资料', category: 'doc', visibility: 'members' }, 32);
    await uploadOne(ctx, admin, { title: '公开资料', category: 'doc', visibility: 'public' }, 32);

    const asGuest = await ctx.svc.listResources(guest.token, new URLSearchParams());
    assert.equal(asGuest.total, 2, '有账号应该两条都看得到');

    const asAnon = await ctx.svc.listResources(null, new URLSearchParams());
    assert.equal(asAnon.total, 1, '没登录只看得到公开的那条');
    assert.equal(asAnon.resources[0].title, '公开资料');

    const asAdmin = await ctx.svc.listResources(admin.token, new URLSearchParams());
    assert.equal(asAdmin.total, 2);
  });

  await t.test('匿名访客同样只看得到公开资源', async () => {
    const { ctx, admin } = await withGuest();
    await uploadOne(ctx, admin, { title: '内部资料', category: 'doc', visibility: 'members' }, 32);
    const anon = await ctx.svc.listResources(null, new URLSearchParams());
    assert.equal(anon.total, 0);
  });

  await t.test('没登录时直接点内部资料的下载地址也拿不到', async () => {
    const { ctx, admin } = await withGuest();
    const made = await uploadOne(ctx, admin, { title: '内部资料', category: 'doc', visibility: 'members' }, 32);
    await assert.rejects(() => ctx.svc.download(null, made.id), /登录/);
  });

  await t.test('游客能下载内部资料', async () => {
    const { ctx, admin, guest } = await withGuest();
    const made = await uploadOne(ctx, admin, { title: '内部资料', category: 'doc', visibility: 'members' }, 32);
    const got = await ctx.svc.download(guest.token, made.id);
    assert.equal(got.resource.title, '内部资料');
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

/* ── 编辑资源 ───────────────────────────────────────────── */

test('编辑资源', async (t) => {
  async function withMembers() {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 5 });
    const member = await ctx.svc.register({ username: '成员甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    return { ctx, admin, member };
  }

  await t.test('管理员能改任意资源的标题和分类——这就是"换位置"', async () => {
    const { ctx, admin, member } = await withMembers();
    const made = await uploadOne(ctx, member, { title: '旧标题', category: 'doc' }, 32);

    const updated = await ctx.svc.updateResource(admin.token, made.id, { title: '新标题', category: 'software' });
    assert.equal(updated.title, '新标题');
    assert.equal(updated.category, 'software');
    assert.equal(updated.categoryName, '软件');
  });

  await t.test('改完之后列表里就是新的分类了', async () => {
    const { ctx, admin, member } = await withMembers();
    const made = await uploadOne(ctx, member, { title: '待搬家', category: 'doc' }, 32);
    await ctx.svc.updateResource(admin.token, made.id, { category: 'design' });

    const byDesign = await ctx.svc.listResources(admin.token, new URLSearchParams({ category: 'design' }));
    assert.equal(byDesign.total, 1);
    assert.equal(byDesign.resources[0].title, '待搬家');

    const byDoc = await ctx.svc.listResources(admin.token, new URLSearchParams({ category: 'doc' }));
    assert.equal(byDoc.total, 0, '旧的分类里不该还有它');
  });

  await t.test('只传一个字段时，其余保持原样', async () => {
    const { ctx, admin, member } = await withMembers();
    const made = await uploadOne(ctx, member, {
      title: '原标题', description: '原简介', category: 'doc', visibility: 'members',
    }, 32);

    const updated = await ctx.svc.updateResource(admin.token, made.id, { title: '改了标题' });
    assert.equal(updated.title, '改了标题');
    assert.equal(updated.description, '原简介');
    assert.equal(updated.category, 'doc');
    assert.equal(updated.visibility, 'members');
  });

  await t.test('成员能改自己的', async () => {
    const { ctx, member } = await withMembers();
    const made = await uploadOne(ctx, member, { title: '我的文件', category: 'doc' }, 32);
    const updated = await ctx.svc.updateResource(member.token, made.id, { title: '我改的' });
    assert.equal(updated.title, '我改的');
  });

  await t.test('成员改不了别人的', async () => {
    const { ctx, admin, member } = await withMembers();
    const made = await uploadOne(ctx, admin, { title: '管理员的文件', category: 'doc' }, 32);
    await assert.rejects(() => ctx.svc.updateResource(member.token, made.id, { title: '偷改' }), /改不了/);
  });

  await t.test('游客改不了任何东西', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'guest', maxUses: 5 });
    const guest = await ctx.svc.register({ username: '游客甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    const made = await uploadOne(ctx, admin, { title: '文件', category: 'doc' }, 32);
    await assert.rejects(() => ctx.svc.updateResource(guest.token, made.id, { title: '改一下' }), /改不了/);
  });

  await t.test('没登录更不能改', async () => {
    const { ctx, admin } = await withMembers();
    const made = await uploadOne(ctx, admin, { title: '文件', category: 'doc' }, 32);
    await assert.rejects(() => ctx.svc.updateResource(null, made.id, { title: '改' }), /登录/);
  });

  await t.test('认不出的分类回落到「其他」', async () => {
    const { ctx, admin, member } = await withMembers();
    const made = await uploadOne(ctx, member, { title: '文件', category: 'doc' }, 32);
    const updated = await ctx.svc.updateResource(admin.token, made.id, { category: '不存在的分类' });
    assert.equal(updated.category, 'other');
  });

  await t.test('改完之后下载次数不会被抹掉', async () => {
    const { ctx, admin, member } = await withMembers();
    const made = await uploadOne(ctx, member, { title: '文件', category: 'doc', visibility: 'public' }, 32);
    await ctx.svc.download(null, made.id);
    await ctx.svc.updateResource(admin.token, made.id, { title: '改个名' });
    const list = await ctx.svc.listResources(admin.token, new URLSearchParams());
    assert.equal(list.resources[0].downloads, 1);
  });
});

/* ── 用量保护 ───────────────────────────────────────────── */

test('用量保护', async (t) => {
  /* 把额度调得很小，方便在测试里撞到边界：
     总额度 1000 字节，预留 200，也就是最多只能用 800。 */
  const TIGHT = {
    bootstrapCode: 'OPEN-SESAME',
    storageLimitBytes: 1000,
    storageReserveBytes: 200,
    storageWarnPercent: 80,
  };

  await t.test('空间够的时候正常上传', async () => {
    const ctx = setup(TIGHT);
    const admin = await makeAdmin(ctx);
    const made = await uploadOne(ctx, admin, { title: '小文件', category: 'doc' }, 300);
    assert.equal(made.title, '小文件');
  });

  await t.test('放不下就直接拒绝，并说明原因', async () => {
    const ctx = setup(TIGHT);
    const admin = await makeAdmin(ctx);
    await uploadOne(ctx, admin, { title: '先占位', category: 'doc' }, 700);
    await assert.rejects(
      () => ctx.svc.startUpload(admin.token, { fileName: '大文件.bin', fileSize: 500 }),
      /存储空间/,
    );
  });

  await t.test('用了八成进入警告档，但还没锁', async () => {
    const ctx = setup(TIGHT);
    const admin = await makeAdmin(ctx);
    await uploadOne(ctx, admin, { title: '占位', category: 'doc' }, 700);
    const report = await ctx.svc.usageReport(admin.token);
    assert.equal(report.level, 'warn');
    assert.equal(report.blocked, false);
    assert.equal(report.percent, 88);
  });

  await t.test('顶满之后，未登录的人下不了', async () => {
    const ctx = setup(TIGHT);
    const admin = await makeAdmin(ctx);
    const made = await uploadOne(ctx, admin, { title: '公开文件', category: 'doc', visibility: 'public' }, 800);
    await assert.rejects(() => ctx.svc.download(null, made.id), /暂时停止下载/);
  });

  await t.test('顶满之后，普通账号也下不了', async () => {
    const ctx = setup(TIGHT);
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'guest', maxUses: 5 });
    const guest = await ctx.svc.register({ username: '游客甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    const made = await uploadOne(ctx, admin, { title: '公开文件', category: 'doc', visibility: 'public' }, 800);
    await assert.rejects(() => ctx.svc.download(guest.token, made.id), /暂时停止下载/);
  });

  await t.test('顶满之后管理员仍能下载——他要能取回文件、把空间清出来', async () => {
    const ctx = setup(TIGHT);
    const admin = await makeAdmin(ctx);
    const made = await uploadOne(ctx, admin, { title: '公开文件', category: 'doc', visibility: 'public' }, 800);
    const got = await ctx.svc.download(admin.token, made.id);
    assert.equal(got.resource.title, '公开文件');
  });

  await t.test('前端少报大小时，最后一步会拦住并把分片清掉', async () => {
    const ctx = setup(TIGHT);
    const admin = await makeAdmin(ctx);

    /* 开始时报 10 字节（骗过第一道检查），实际传 900 字节。 */
    const started = await ctx.svc.startUpload(admin.token, { fileName: '撒谎.bin', fileSize: 10 });
    const part = await ctx.svc.uploadPart(admin.token, {
      key: started.key, uploadId: started.uploadId, partNumber: 1, partCount: 1, data: new Uint8Array(900),
    });

    await assert.rejects(
      () => ctx.svc.completeUpload(admin.token, {
        key: started.key,
        uploadId: started.uploadId,
        resourceId: started.resourceId,
        partSize: started.partSize,
        parts: [part],
        meta: { title: '撒谎的文件', category: 'doc' },
        file: { name: '撒谎.bin', size: 900, mime: 'application/octet-stream' },
      }),
      /存储空间/,
    );

    assert.equal(ctx.files.aborts.length, 1, '应该已经放弃这次上传');
    const list = await ctx.svc.listResources(admin.token, new URLSearchParams());
    assert.equal(list.total, 0, '不该留下资源记录');
  });

  await t.test('把「满了也停下载」关掉后，只在满的时候停上传', async () => {
    const ctx = setup(Object.assign({}, TIGHT, { blockDownloadsWhenFull: false }));
    const admin = await makeAdmin(ctx);
    const made = await uploadOne(ctx, admin, { title: '公开文件', category: 'doc', visibility: 'public' }, 800);
    const got = await ctx.svc.download(null, made.id);
    assert.equal(got.resource.title, '公开文件');
  });

  await t.test('用量报表谁都看得到，成员和没登录的都能看', async () => {
    const ctx = setup(TIGHT);
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 5 });
    const member = await ctx.svc.register({ username: '成员甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    await uploadOne(ctx, admin, { title: '占了七百', category: 'doc' }, 700);

    const asMember = await ctx.svc.usageReport(member.token);
    const asGuest = await ctx.svc.usageReport();
    assert.equal(asMember.level, 'warn');
    assert.equal(asGuest.level, 'warn');
    assert.equal(asGuest.usedBytes, 700);
    assert.equal(asGuest.limitText, '1000 B');
  });

  await t.test('删掉文件腾出空间后，又能传了', async () => {
    const ctx = setup(TIGHT);
    const admin = await makeAdmin(ctx);
    const made = await uploadOne(ctx, admin, { title: '占位', category: 'doc' }, 800);
    await assert.rejects(() => ctx.svc.startUpload(admin.token, { fileName: 'x', fileSize: 100 }), /存储空间/);

    await ctx.svc.deleteResource(admin.token, made.id);
    const again = await ctx.svc.startUpload(admin.token, { fileName: 'x', fileSize: 100 });
    assert.equal(!!again.key, true, '腾出空间后应该能继续传');
  });
});

/* ── 每人配额 ───────────────────────────────────────────── */

test('每人配额', async (t) => {
  /* 每个成员 1000 字节，用到八成开始提醒。管理员不占这个额度。 */
  const CAP = { bootstrapCode: 'OPEN-SESAME', userQuotaBytes: 1000, userQuotaWarnPercent: 80 };

  async function withMember(ctx) {
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 5 });
    const member = await ctx.svc.register({ username: '成员甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    return { admin, member };
  }

  await t.test('传超了会被挡下，并且说清还剩多少', async () => {
    const ctx = setup(CAP);
    const { member } = await withMember(ctx);
    await uploadOne(ctx, member, { title: '占了六百', category: 'doc' }, 600);

    const err = await ctx.svc.startUpload(member.token, { fileName: '大文件.bin', fileSize: 500 }).catch((e) => e);
    assert.equal(err.status, 413);
    assert.match(err.message, /400 B/);
  });

  await t.test('刚好放得下就放行', async () => {
    const ctx = setup(CAP);
    const { member } = await withMember(ctx);
    await uploadOne(ctx, member, { title: '占了六百', category: 'doc' }, 600);
    const started = await ctx.svc.startUpload(member.token, { fileName: '刚好.bin', fileSize: 400 });
    assert.equal(!!started.key, true);
  });

  await t.test('别人的文件不占我的额度', async () => {
    const ctx = setup(CAP);
    const { admin, member } = await withMember(ctx);
    await uploadOne(ctx, admin, { title: '管理员的大件', category: 'doc' }, 900);
    const started = await ctx.svc.startUpload(member.token, { fileName: '我的.bin', fileSize: 900 });
    assert.equal(!!started.key, true);
  });

  await t.test('管理员不受这个额度限制', async () => {
    const ctx = setup(CAP);
    const admin = await makeAdmin(ctx);
    await uploadOne(ctx, admin, { title: '第一份', category: 'doc' }, 900);
    const started = await ctx.svc.startUpload(admin.token, { fileName: '再来.bin', fileSize: 5000 });
    assert.equal(!!started.key, true);
  });

  await t.test('删掉自己的文件就把额度腾出来了', async () => {
    const ctx = setup(CAP);
    const { member } = await withMember(ctx);
    const made = await uploadOne(ctx, member, { title: '占了六百', category: 'doc' }, 600);
    await ctx.svc.deleteResource(member.token, made.id);
    const started = await ctx.svc.startUpload(member.token, { fileName: '再来.bin', fileSize: 900 });
    assert.equal(!!started.key, true);
  });

  await t.test('已经超了的老账号：旧文件留着，只是不能再传', async () => {
    const ctx = setup(CAP);
    const { member } = await withMember(ctx);
    /* 直接塞一份超过额度的老数据，模拟改规矩之前就传上去的东西。 */
    await ctx.store.resources.insert({
      id: 'r_old', owner_id: member.user.id, owner_name: member.user.username,
      title: '以前传的大件', description: '', category: 'doc', platform: '', visibility: 'public',
      r2_key: 'u/' + member.user.id + '/r_old.bin', file_name: '老东西.bin', file_size: 5000,
      mime: 'application/octet-stream', downloads: 0, created_at: new Date(ctx.clock.now()).toISOString(),
    });

    assert.equal((await ctx.store.resources.byId('r_old')).title, '以前传的大件', '旧文件不该被动');
    const err = await ctx.svc.startUpload(member.token, { fileName: '新的.bin', fileSize: 1 }).catch((e) => e);
    assert.equal(err.status, 413);
  });

  await t.test('用到八成进警告档，还没锁住', async () => {
    const ctx = setup(CAP);
    const { member } = await withMember(ctx);
    await uploadOne(ctx, member, { title: '占了八百五', category: 'doc' }, 850);
    const report = await ctx.svc.quotaReport(member.token);
    assert.equal(report.level, 'warn');
    assert.equal(report.blocked, false);
    assert.equal(report.usedBytes, 850);
    assert.equal(report.limitBytes, 1000);
  });

  await t.test('顶满之后就是拦住档', async () => {
    const ctx = setup(CAP);
    const { member } = await withMember(ctx);
    await uploadOne(ctx, member, { title: '占满', category: 'doc' }, 1000);
    const report = await ctx.svc.quotaReport(member.token);
    assert.equal(report.blocked, true);
    assert.equal(report.remainingBytes, 0);
  });

  await t.test('谁都能看自己的额度，不用管理员', async () => {
    const ctx = setup(CAP);
    const { member } = await withMember(ctx);
    const report = await ctx.svc.quotaReport(member.token);
    assert.equal(report.usedBytes, 0);
    assert.equal(report.limitText, '1000 B');
  });

  await t.test('管理员看到的是「不限额」', async () => {
    const ctx = setup(CAP);
    const admin = await makeAdmin(ctx);
    const report = await ctx.svc.quotaReport(admin.token);
    assert.equal(report.unlimited, true);
    assert.equal(report.blocked, false);
  });

  await t.test('前端少报大小也绕不过额度', async () => {
    const ctx = setup(CAP);
    const { member } = await withMember(ctx);
    await uploadOne(ctx, member, { title: '先占六百', category: 'doc' }, 600);

    const started = await ctx.svc.startUpload(member.token, { fileName: '撒谎.bin', fileSize: 10 });
    const part = await ctx.svc.uploadPart(member.token, {
      key: started.key, uploadId: started.uploadId, partNumber: 1, partCount: 1, data: new Uint8Array(500),
    });
    await assert.rejects(
      () => ctx.svc.completeUpload(member.token, {
        key: started.key,
        uploadId: started.uploadId,
        resourceId: started.resourceId,
        partSize: started.partSize,
        parts: [part],
        meta: { title: '撒谎的文件', category: 'doc' },
        file: { name: '撒谎.bin', size: 500, mime: 'application/octet-stream' },
      }),
      /额度/,
    );
    assert.equal(ctx.files.aborts.length, 1, '应该已经放弃这次上传');
  });
});

/* ── 邀请码作废 ─────────────────────────────────────────── */

test('邀请码作废', async (t) => {
  await t.test('作废之后谁也用不了', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 1 });

    await ctx.svc.revokeInvite(admin.token, invite.code);
    await assert.rejects(
      () => ctx.svc.register({ username: '小明', password: 'harbor-lantern-77', inviteCode: invite.code }),
      /作废/,
    );
  });

  await t.test('列表里能看出哪个作废了', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 1 });

    const before = await ctx.svc.listInvites(admin.token);
    assert.equal(before[0].revoked, false);

    await ctx.svc.revokeInvite(admin.token, invite.code);
    const after = await ctx.svc.listInvites(admin.token);
    assert.equal(after[0].revoked, true);
  });

  await t.test('普通成员作废不了', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 1 });
    const member = await ctx.svc.register({ username: '成员甲', password: 'harbor-lantern-77', inviteCode: invite.code });
    const another = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 1 });

    await assert.rejects(() => ctx.svc.revokeInvite(member.token, another.code), /管理员/);
  });

  await t.test('作废一个不存在的码会说清楚', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    await assert.rejects(() => ctx.svc.revokeInvite(admin.token, 'ZZZZZZZZZZ'), /没找到/);
  });

  await t.test('已经用掉的码照样能标作废，不报错', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 1 });
    await ctx.svc.register({ username: '小明', password: 'harbor-lantern-77', inviteCode: invite.code });

    const result = await ctx.svc.revokeInvite(admin.token, invite.code);
    assert.equal(result.ok, true);
  });
});
/* ── 账号自己的背景字母 ─────────────────────────────────── */

test('账号背景字母', async (t) => {
  async function withMember() {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 5 });
    const member = await ctx.svc.register({ username: '小明', password: 'harbor-lantern-77', inviteCode: invite.code });
    return { ctx, admin, member };
  }

  await t.test('刚注册时没有字母', async () => {
    const { ctx, member } = await withMember();
    const mine = await ctx.svc.myLetters(member.token);
    assert.equal(mine.letters, '');
    assert.equal(mine.limit, 4);
  });

  await t.test('设一次就能读到，也会出现在背景列表里', async () => {
    const { ctx, member } = await withMember();
    await ctx.svc.setMyLetters(member.token, { letters: 'hc' });
    assert.equal((await ctx.svc.myLetters(member.token)).letters, 'hc');
    assert.deepEqual(await ctx.svc.backgroundLetters(), ['hc']);
  });

  await t.test('最多四个字，多的截掉', async () => {
    const { ctx, member } = await withMember();
    const saved = await ctx.svc.setMyLetters(member.token, { letters: 'abcdEFG' });
    assert.equal(saved.letters, 'abcd');
  });

  await t.test('空格和乱七八糟的符号会被清掉', async () => {
    const { ctx, member } = await withMember();
    const saved = await ctx.svc.setMyLetters(member.token, { letters: ' h<c > ' });
    assert.equal(saved.letters, 'hc');
  });

  await t.test('全是符号就等于没写，会被拒', async () => {
    const { ctx, member } = await withMember();
    await assert.rejects(() => ctx.svc.setMyLetters(member.token, { letters: '<>!!' }), /1 到 4 个字/);
  });

  await t.test('再设一次是覆盖，不是叠加', async () => {
    const { ctx, member } = await withMember();
    await ctx.svc.setMyLetters(member.token, { letters: 'hc' });
    await ctx.svc.setMyLetters(member.token, { letters: 'cyr' });
    assert.equal((await ctx.svc.myLetters(member.token)).letters, 'cyr');
    assert.deepEqual(await ctx.svc.backgroundLetters(), ['cyr']);
  });

  await t.test('删掉之后背景里也没有了', async () => {
    const { ctx, member } = await withMember();
    await ctx.svc.setMyLetters(member.token, { letters: 'hc' });
    await ctx.svc.clearMyLetters(member.token);
    assert.equal((await ctx.svc.myLetters(member.token)).letters, '');
    assert.deepEqual(await ctx.svc.backgroundLetters(), []);
  });

  await t.test('没登录不能读写', async () => {
    const { ctx } = await withMember();
    await assert.rejects(() => ctx.svc.myLetters(''), /登录/);
    await assert.rejects(() => ctx.svc.setMyLetters('', { letters: 'hc' }), /登录/);
  });

  await t.test('各人管各人的，最多显示 8 组、新的在前', async () => {
    const ctx = setup({ bootstrapCode: 'OPEN-SESAME' });
    const admin = await makeAdmin(ctx);
    for (let i = 0; i < 9; i++) {
      const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 1 });
      const who = await ctx.svc.register({ username: '成员' + i, password: 'harbor-lantern-77', inviteCode: invite.code });
      await ctx.svc.setMyLetters(who.token, { letters: 'L' + i });
      ctx.clock.advance(1000);
    }
    const list = await ctx.svc.backgroundLetters();
    assert.equal(list.length, 8);
    assert.equal(list[0], 'L8');
    assert.equal(list.includes('L0'), false);
  });
});