'use strict';

/* 应用逻辑：把规则、存储、文件三块拼起来。
   这里是唯一的业务入口，Worker 只负责搬运 HTTP。 */

import crypto from 'node:crypto';

import { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooLarge } from './errors.js';
import { checkPassword } from './password.js';
import { checkInvite, normalizeCode, generateCode } from './invite.js';
import { can, canSee, canEdit, canDelete } from './roles.js';
import { checkLoginAllowed, WINDOW_MS } from './loginGuard.js';
import * as uploads from './uploads.js';
import * as catalog from './resources.js';
import { evaluateUsage, canStore, GUARD_DEFAULTS } from './guard.js';
import { evaluateQuota, canStoreMore, QUOTA_DEFAULTS } from './quota.js';
import { imageTypeOf, canPreview } from './preview.js';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const USERNAME_RE = /^[\w\u4e00-\u9fa5-]{2,20}$/;
const VIEWER_ANONYMOUS = 'anonymous';
const CODE_BYTES = 16;   // 邀请码取模用，给足随机量
const LETTER_LIMIT = 4;  // 背景字母最多几个字

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/* 定时安全比较，避免通过响应时间猜出口令。 */
function passwordMatches(user, password) {
  const given = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored = Buffer.from(user.password_hash, 'hex');
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
}

function createService(options) {
  const store = options.store;
  const files = options.files;
  const now = options.now || (() => Date.now());
  const uuid = options.uuid || (() => crypto.randomBytes(9).toString('hex'));
  const token = options.token || (() => crypto.randomBytes(24).toString('hex'));
  const randomBytes = options.randomBytes || ((n) => crypto.randomBytes(n));
  const bootstrapCode = options.bootstrapCode || '';
  const backend = options.backend || 'r2';

  /* 用量保护：接近免费额度就报警，顶到上限就拦住，避免产生费用。 */
  const guardConfig = {
    limitBytes: options.storageLimitBytes || GUARD_DEFAULTS.limitBytes,
    reserveBytes: options.storageReserveBytes || GUARD_DEFAULTS.reserveBytes,
    warnPercent: options.storageWarnPercent || GUARD_DEFAULTS.warnPercent,
  };
  const blockDownloadsWhenFull = options.blockDownloadsWhenFull !== false;

  /* 每人一份额度，管理员不受限。默认 1GB。 */
  const quotaConfig = {
    limitBytes: options.userQuotaBytes || QUOTA_DEFAULTS.limitBytes,
    warnPercent: options.userQuotaWarnPercent || QUOTA_DEFAULTS.warnPercent,
  };

  async function currentUsage() {
    return evaluateUsage(await store.resources.totalBytes(), guardConfig);
  }

  function fullMessage() {
    return '存储空间已经满了，为避免产生费用，暂时停止上传。请联系管理员清理。';
  }

  /* 某个人现在用了多少额度。管理员不算这个额度，他是来管事的。 */
  async function quotaState(user) {
    const unlimited = can(user.role, 'manageUsers');
    const usedBytes = unlimited ? 0 : await store.resources.bytesByOwner(user.id);
    return evaluateQuota(usedBytes, {
      limitBytes: quotaConfig.limitBytes,
      warnPercent: quotaConfig.warnPercent,
      unlimited,
    });
  }

  function quotaMessage(quota, size) {
    return '你的上传额度不够了：还剩 ' + catalog.humanSize(quota.remainingBytes)
      + '，这份要 ' + catalog.humanSize(size) + '。删掉一些自己传的文件就能腾出来。';
  }

  async function quotaReport(sessionToken) {
    const user = await requireUser(sessionToken);
    const quota = await quotaState(user);
    return {
      ...quota,
      usedText: catalog.humanSize(quota.usedBytes),
      limitText: quota.unlimited ? '不限额' : catalog.humanSize(quota.limitBytes),
      remainingText: quota.unlimited ? '不限额' : catalog.humanSize(quota.remainingBytes),
    };
  }

  const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role });

  async function requireUser(sessionToken) {
    if (!sessionToken) throw unauthorized('登录之后再来');
    const session = await store.sessions.byToken(sessionToken);
    if (!session) throw unauthorized('登录状态已失效，重新登录一下');
    if (session.expires_at <= new Date(now()).toISOString()) {
      await store.sessions.remove(sessionToken);
      throw unauthorized('登录状态已过期，重新登录一下');
    }
    const user = await store.users.byId(session.user_id);
    if (!user || user.disabled_at) throw unauthorized('这个账号已经不能用了');
    return user;
  }

  async function optionalUser(sessionToken) {
    if (!sessionToken) return null;
    try { return await requireUser(sessionToken); } catch (e) { return null; }
  }

  async function startSession(user) {
    const value = token();
    await store.sessions.insert({
      token: value,
      user_id: user.id,
      created_at: new Date(now()).toISOString(),
      expires_at: new Date(now() + SESSION_TTL_MS).toISOString(),
    });
    return value;
  }

  /* 注册。需要邀请码；系统里一个人都没有时，允许用一次性暗号建第一个管理员。 */
  async function register(input) {
    const username = String(input.username || '').trim();
    if (!USERNAME_RE.test(username)) {
      throw badRequest('昵称请用 2-20 个字，中文、字母、数字或下划线都行');
    }
    const problems = checkPassword(input.password, { username });
    if (problems.length) throw badRequest(problems.join('；'));

    const lower = username.toLowerCase();
    if (await store.users.byUsername(lower)) throw conflict('这个昵称已经有人用了，换一个吧');

    let role = null;

    /* 页面上只有一个「邀请码」输入框，所以初始暗号也是从这个字段进来的。
       先当成邀请码去找；找不到，再比一比是不是初始暗号。
       这两条路必须都走通，否则第一个管理员根本建不出来。 */
    const code = normalizeCode(input.inviteCode) || normalizeCode(input.bootstrapCode);
    if (!code) throw badRequest('注册需要邀请码');

    const invite = await store.invites.byCode(code);
    if (invite) {
      const verdict = checkInvite(invite, now());
      if (!verdict.ok) throw badRequest(verdict.reason);
      role = invite.role;
    } else if (bootstrapCode && code === normalizeCode(bootstrapCode)) {
      const count = await store.users.count();
      if (count > 0) throw forbidden('初始化暗号只能用一次，请改用邀请码');
      role = 'admin';
    } else {
      throw badRequest('没找到这个邀请码，确认一下有没有抄错');
    }

    const salt = randomBytes(16).toString('hex');
    const user = {
      id: 'u_' + uuid(),
      username,
      username_lower: lower,
      password_hash: hashPassword(input.password, salt),
      salt,
      role,
      created_at: new Date(now()).toISOString(),
      disabled_at: null,
    };
    await store.users.insert(user);
    if (code) await store.invites.consume(code);

    const sessionToken = await startSession(user);
    return { user: publicUser(user), token: sessionToken };
  }

  async function login(input) {
    const username = String(input.username || '').trim();
    const lower = username.toLowerCase();
    const since = now() - WINDOW_MS;
    const recent = await store.failures.recent(lower, since);

    const guard = checkLoginAllowed(recent, now());
    if (!guard.allowed) {
      throw new AppError(429, '试得太频繁了，' + (guard.minutes || 15) + ' 分钟后再试');
    }

    const user = await store.users.byUsername(lower);
    /* 账号不存在和密码错误给同一句话，不让人试探出哪些昵称存在。 */
    if (!user || !user.password_hash || !passwordMatches(user, String(input.password || ''))) {
      await store.failures.record(lower, now());
      throw unauthorized('昵称或密码不对，再确认一下');
    }
    if (user.disabled_at) throw forbidden('这个账号已经停用了');

    await store.failures.clear(lower);
    const sessionToken = await startSession(user);
    return { user: publicUser(user), token: sessionToken };
  }

  async function logout(sessionToken) {
    if (sessionToken) await store.sessions.remove(sessionToken);
    return { ok: true };
  }

  async function changePassword(sessionToken, input) {
    const user = await requireUser(sessionToken);
    if (!passwordMatches(user, String(input.current || ''))) {
      throw unauthorized('当前密码不对');
    }
    const problems = checkPassword(input.next, { username: user.username });
    if (problems.length) throw badRequest(problems.join('；'));

    const salt = randomBytes(16).toString('hex');
    await store.users.updatePassword(user.id, hashPassword(input.next, salt), salt);
    /* 改完密码，其它设备上的登录状态全部失效，当前这台重新发一个。 */
    await store.sessions.removeByUser(user.id);
    const fresh = await startSession(user);
    return { ok: true, token: fresh };
  }

  async function createInvite(sessionToken, input) {
    const user = await requireUser(sessionToken);
    if (!can(user.role, 'createInvite')) throw forbidden('只有管理员能生成邀请码');

    const role = ['admin', 'member', 'guest'].includes(input.role) ? input.role : 'member';
    const maxUses = Math.min(Math.max(Number(input.maxUses) || 1, 1), 100);
    const days = Number(input.expiresInDays);
    const expiresAt = Number.isFinite(days) && days > 0
      ? new Date(now() + days * 86400000).toISOString()
      : null;

    let code = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateCode(randomBytes(CODE_BYTES));
      if (!(await store.invites.byCode(candidate))) { code = candidate; break; }
    }
    if (!code) throw new AppError(500, '邀请码生成失败，稍后再试');

    const invite = {
      code,
      role,
      max_uses: maxUses,
      used_count: 0,
      expires_at: expiresAt,
      revoked_at: null,
      created_by: user.id,
      created_at: new Date(now()).toISOString(),
    };
    await store.invites.insert(invite);
    return {
      code: invite.code,
      formatted: invite.code.slice(0, 5) + '-' + invite.code.slice(5),
      role: invite.role,
      maxUses: invite.max_uses,
      usedCount: 0,
      expiresAt: invite.expires_at,
    };
  }

  async function listInvites(sessionToken) {
    const user = await requireUser(sessionToken);
    if (!can(user.role, 'manageUsers')) throw forbidden('只有管理员能看邀请码');
    const all = await store.invites.all();
    return all.map((i) => ({
      code: i.code,
      formatted: i.code.slice(0, 5) + '-' + i.code.slice(5),
      role: i.role,
      maxUses: i.max_uses,
      usedCount: i.used_count,
      expiresAt: i.expires_at,
      revoked: !!i.revoked_at,
      createdAt: i.created_at,
    }));
  }

  /* 作废一个邀请码：立刻生效，已经用掉的不受影响。 */
  async function revokeInvite(sessionToken, code) {
    const user = await requireUser(sessionToken);
    if (!can(user.role, 'manageUsers')) throw forbidden('只有管理员能作废邀请码');

    const normalized = normalizeCode(code);
    if (!normalized) throw badRequest('要先说清作废哪一个邀请码');

    const invite = await store.invites.byCode(normalized);
    if (!invite) throw notFound('没找到这个邀请码');

    await store.invites.revoke(normalized, new Date(now()).toISOString());
    return { ok: true, code: normalized };
  }

  /* 背景字母：账号自己挑的那串字。
     只允许中文、字母、数字、下划线，最多四个字。 */
  function cleanLetters(raw) {
    return String(raw == null ? '' : raw)
      .replace(/\s+/g, '')
      .replace(/[^\w\u4e00-\u9fa5]/g, '')
      .slice(0, LETTER_LIMIT);
  }

  async function myLetters(sessionToken) {
    const user = await requireUser(sessionToken);
    return { letters: user.bg_letters || '', limit: LETTER_LIMIT };
  }

  async function setMyLetters(sessionToken, input) {
    const user = await requireUser(sessionToken);
    const letters = cleanLetters(input && input.letters);
    if (!letters) throw badRequest('写 1 到 4 个字吧，中文、字母、数字都行');
    await store.users.setLetters(user.id, letters);
    return { ok: true, letters };
  }

  async function clearMyLetters(sessionToken) {
    const user = await requireUser(sessionToken);
    await store.users.setLetters(user.id, '');
    return { ok: true };
  }

  /* 背景里要摆的：设过字母的账号，最新的排前面，最多给 8 组。 */
  async function backgroundLetters() {
    const rows = await store.users.withLetters(8);
    return rows.map((u) => u.bg_letters).filter(Boolean);
  }

  async function listUsers(sessionToken) {
    const user = await requireUser(sessionToken);
    if (!can(user.role, 'manageUsers')) throw forbidden('只有管理员能看用户列表');
    const all = await store.users.all();
    return all.map((u) => ({ id: u.id, username: u.username, role: u.role, createdAt: u.created_at }));
  }

  async function listResources(sessionToken, query) {
    const viewer = await optionalUser(sessionToken);
    const role = viewer ? viewer.role : VIEWER_ANONYMOUS;
    const visibilities = can(role, 'seeMembersOnly') ? ['public', 'members'] : ['public'];

    const rows = await store.resources.query({
      category: query.get('category') || '',
      platform: query.get('platform') || '',
      keyword: (query.get('q') || '').trim(),
      ownerId: query.get('owner') === 'me' && viewer ? viewer.id : '',
      visibilities,
    });
    const sorted = catalog.sortList(rows, query.get('sort') || 'new', viewer);
    return { total: sorted.length, resources: sorted.map((r) => catalog.present(r, viewer)) };
  }

  async function startUpload(sessionToken, input) {
    const user = await requireUser(sessionToken);
    if (!can(user.role, 'upload')) throw forbidden('当前账号只能下载，不能上传');

    /* 先按前端报的大小估一下，放不下就别开始传 —— 传完再拒绝，钱已经花了。 */
    const usage = await currentUsage();
    if (usage.blocked || !canStore(usage, input.fileSize)) {
      throw new AppError(507, fullMessage());
    }

    /* 再看他自己的额度够不够。管理员 unlimited，这里直接放行。 */
    const quota = await quotaState(user);
    if (!canStoreMore(quota, input.fileSize)) {
      throw tooLarge(quotaMessage(quota, input.fileSize));
    }

    const fileName = String(input.fileName || 'file');
    const resourceId = 'r_' + uuid();
    const key = uploads.buildKey(user.id, resourceId, fileName);
    const multipart = await files.createMultipart(key);
    return { key, uploadId: multipart.uploadId, resourceId, partSize: uploads.rulesFor(backend).partSize };
  }

  async function uploadPart(sessionToken, input) {
    const user = await requireUser(sessionToken);
    if (!can(user.role, 'upload')) throw forbidden('当前账号只能下载，不能上传');
    if (!uploads.keyBelongsTo(input.key, user.id)) throw forbidden('这不是你的上传任务');

    const verdict = uploads.checkPartSize(input.data.length, input.partNumber, input.partCount, backend);
    if (!verdict.ok) throw badRequest(verdict.reason);

    const multipart = await files.resumeMultipart(input.key, input.uploadId);
    const part = await multipart.uploadPart(Number(input.partNumber), input.data);
    return { partNumber: Number(part.partNumber), etag: part.etag };
  }

  async function completeUpload(sessionToken, input) {
    const user = await requireUser(sessionToken);
    if (!can(user.role, 'upload')) throw forbidden('当前账号只能下载，不能上传');
    if (!uploads.keyBelongsTo(input.key, user.id)) throw forbidden('这不是你的上传任务');

    const fileSize = Number(input.file && input.file.size);
    const verdict = uploads.validateParts(input.parts, fileSize, input.partSize || uploads.rulesFor(backend).partSize, backend);
    if (!verdict.ok) throw badRequest(verdict.reason);

    const meta = catalog.validateMeta(input.meta || {});
    const multipart = await files.resumeMultipart(input.key, input.uploadId);

    /* 前端可能少报了大小，这里拿真实值再判一次。
       放不下就直接放弃这次上传，别把分片留在存储里占地方。 */
    const usage = await currentUsage();
    if (usage.blocked || !canStore(usage, fileSize)) {
      try { await multipart.abort(); } catch (e) { /* 放弃失败也没办法，继续报错 */ }
      throw new AppError(507, fullMessage());
    }

    /* 同一个人自己的额度也要再核一遍，前端少报大小也绕不过去。 */
    const quota = await quotaState(user);
    if (!canStoreMore(quota, fileSize)) {
      try { await multipart.abort(); } catch (e) { /* 放弃失败也没办法，继续报错 */ }
      throw tooLarge(quotaMessage(quota, fileSize));
    }

    await multipart.complete(input.parts.map((p) => ({ partNumber: Number(p.partNumber), etag: p.etag })));

    const resource = {
      id: input.resourceId || 'r_' + uuid(),
      owner_id: user.id,
      owner_name: user.username,
      title: meta.title,
      description: meta.description,
      category: meta.category,
      platform: meta.platform,
      visibility: meta.visibility,
      r2_key: input.key,
      file_name: String((input.file && input.file.name) || 'file'),
      file_size: fileSize,
      mime: String((input.file && input.file.mime) || 'application/octet-stream').slice(0, 120),
      downloads: 0,
      created_at: new Date(now()).toISOString(),
    };
    await store.resources.insert(resource);
    return catalog.present(resource, user);
  }

  async function abortUpload(sessionToken, input) {
    const user = await requireUser(sessionToken);
    if (!uploads.keyBelongsTo(input.key, user.id)) throw forbidden('这不是你的上传任务');
    const multipart = await files.resumeMultipart(input.key, input.uploadId);
    await multipart.abort();
    return { ok: true };
  }

  /* 改资源的元信息。管理员能改任何人的，成员只能改自己的。 */
  async function updateResource(sessionToken, id, patch) {
    const user = await requireUser(sessionToken);
    const resource = await store.resources.byId(id);
    if (!resource) throw notFound('这份资源已经不在了');
    if (!canEdit(user.role, user, resource)) throw forbidden('这份资源你改不了');

    /* 没传的字段沿用原值，传了的按新规矩校验一遍。 */
    const merged = {
      title: patch.title !== undefined ? patch.title : resource.title,
      description: patch.description !== undefined ? patch.description : resource.description,
      category: patch.category !== undefined ? patch.category : resource.category,
      platform: patch.platform !== undefined ? patch.platform : resource.platform,
      visibility: patch.visibility !== undefined ? patch.visibility : resource.visibility,
    };
    const meta = catalog.validateMeta(merged);

    await store.resources.update(id, meta);
    const fresh = await store.resources.byId(id);
    return catalog.present(fresh, user);
  }

  /* 用量报表。这条提醒要给所有人看（包括没登录的），
     所以不卡角色；管理面板里的详细那行也用它。 */
  async function usageReport() {
    const usage = await currentUsage();
    return {
      ...usage,
      usedText: catalog.humanSize(usage.usedBytes),
      limitText: catalog.humanSize(usage.limitBytes),
      reserveText: catalog.humanSize(usage.reserveBytes),
      capText: catalog.humanSize(usage.effectiveCapBytes),
      remainingText: catalog.humanSize(usage.remainingBytes),
      blocksDownloads: blockDownloadsWhenFull,
    };
  }

  async function deleteResource(sessionToken, id) {
    const user = await requireUser(sessionToken);
    const resource = await store.resources.byId(id);
    if (!resource) throw notFound('这份资源已经不在了');
    if (!canDelete(user.role, user, resource)) throw forbidden('这份资源不是你上传的，删不了');

    await files.delete(resource.r2_key);
    await store.resources.remove(id);
    return { ok: true };
  }

  /* 预览：拿到图片本身，但不累加下载次数。空间满时和下载一样停掉，
     免得白白花掉读取额度。 */
  async function preview(sessionToken, id) {
    const viewer = await optionalUser(sessionToken);
    const role = viewer ? viewer.role : VIEWER_ANONYMOUS;

    if (blockDownloadsWhenFull && !can(role, 'manageUsers')) {
      const usage = await currentUsage();
      if (usage.blocked) {
        throw new AppError(503, '存储空间已满，为避免产生费用暂时停止下载。请联系管理员。');
      }
    }

    const resource = await store.resources.byId(id);
    if (!resource) throw notFound('这份资源已经不在了');
    if (!canSee(role, resource)) throw forbidden('这份资源要登录才能看');
    if (!canPreview(resource.file_name)) throw new AppError(415, '这种文件不能在线预览，下载下来看吧。');

    const object = await files.read(resource.r2_key);
    return { resource, object, contentType: imageTypeOf(resource.file_name) };
  }

  async function download(sessionToken, id) {
    const viewer = await optionalUser(sessionToken);
    const role = viewer ? viewer.role : VIEWER_ANONYMOUS;

    /* 满了就停止对外下载（管理员除外 —— 他得能取回自己的东西、把空间清出来）。 */
    if (blockDownloadsWhenFull && !can(role, 'manageUsers')) {
      const usage = await currentUsage();
      if (usage.blocked) {
        throw new AppError(503, '存储空间已满，为避免产生费用暂时停止下载。请联系管理员。');
      }
    }
    const resource = await store.resources.byId(id);
    if (!resource) throw notFound('这份资源已经不在了');
    if (!canSee(role, resource)) throw forbidden('这份资源要登录才能看');

    await store.resources.bumpDownloads(id);
    const object = await files.read(resource.r2_key);
    return { resource, object };
  }

  return {
    register, login, logout, changePassword,
    createInvite, listInvites, revokeInvite, listUsers, quotaReport,
    myLetters, setMyLetters, clearMyLetters, backgroundLetters,
    listResources, startUpload, uploadPart, completeUpload, abortUpload, usageReport,
    updateResource, deleteResource, download, preview,
    requireUser, optionalUser, publicUser,
  };
}

export { createService, hashPassword, passwordMatches, SESSION_TTL_MS };
