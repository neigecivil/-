'use strict';

/* HTTP 层：只负责搬运。
   解析请求、调业务逻辑、把结果和错误转成响应。
   业务规则一条都不写在这里。 */

import { createService } from './core/service.js';
import { createD1Store } from './store/d1.js';
import { createKvFiles } from './adapters/kv.js';
import { createR2Files } from './adapters/r2.js';
import { CATEGORIES, PLATFORMS, VISIBILITIES } from './core/resources.js';
import { AppError } from './core/errors.js';

const COOKIE = 'sid';
const SESSION_MAX_AGE = 30 * 24 * 3600;

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }, headers || {}),
  });
}

function fail(err) {
  if (err instanceof AppError) return json({ ok: false, error: err.message }, err.status);
  /* 预料之外的错误只记在服务端日志里，不把内部信息漏给客户端。 */
  console.error('未处理的服务端错误:', (err && err.stack) || err);
  return json({ ok: false, error: '服务器出了点问题，请稍后再试' }, 500);
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

const cookieValue = (token) =>
  COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=' + SESSION_MAX_AGE;

const clearedCookie = () => COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';

async function readJsonBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new AppError(400, '提交的数据格式不正确');
    throw err;
  }
}

/* 文件存哪儿由配置决定：
   FILE_BACKEND 不填或填 r2 —— 用 R2（需要先开通，可选但容量大）
   填 kv —— 用 Workers KV（免费计划自带，容量小一些） */
function filesFor(env) {
  const backend = String(env.FILE_BACKEND || 'r2').toLowerCase();
  return backend === 'kv' ? createKvFiles(env.FILES) : createR2Files(env.FILES);
}

/* 环境变量以 MB 为单位，转成字节。填得不合法就用默认值。 */
function mbToBytes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024 * 1024) : fallback;
}

function buildService(env) {
  return createService({
    store: createD1Store(env.DB),
    files: filesFor(env),
    backend: String(env.FILE_BACKEND || 'r2').toLowerCase(),
    bootstrapCode: env.BOOTSTRAP_CODE || '',
    storageLimitBytes: mbToBytes(env.STORAGE_LIMIT_MB, undefined),
    storageReserveBytes: mbToBytes(env.STORAGE_RESERVE_MB, undefined),
    storageWarnPercent: Number(env.STORAGE_WARN_PERCENT) || undefined,
    /* 每个人自己的额度，默认 1GB；管理员不算这个。 */
    userQuotaBytes: mbToBytes(env.USER_QUOTA_MB, undefined),
    /* 顶到上限时要不要连下载也停掉。默认停；填 false 就只停上传。 */
    blockDownloadsWhenFull: String(env.GUARD_BLOCK_DOWNLOADS || 'true').toLowerCase() !== 'false',
  });
}

async function handleApi(request, env, url) {
  const service = buildService(env);
  const token = readCookie(request, COOKIE);
  const method = request.method.toUpperCase();
  const parts = url.pathname.split('/').filter(Boolean);   // ['api', ...]
  const section = parts[1] || '';
  const id = parts[2] || '';

  if (section === 'catalog' && method === 'GET') {
    return json({ ok: true, categories: CATEGORIES, platforms: PLATFORMS, visibilities: VISIBILITIES });
  }

  if (section === 'me' && method === 'GET') {
    const user = await service.optionalUser(token);
    return json({ ok: true, user: user ? service.publicUser(user) : null });
  }
  /* 每个人都能看自己用掉多少上传额度，不用管理员。 */
  if (section === 'quota' && method === 'GET') {
    const quota = await service.quotaReport(token);
    return json({ ok: true, quota });
  }
  /* 整站用了多少存储。所有人（含没登录的）都能看，页面顶上那条提醒靠它。 */
  if (section === 'usage' && method === 'GET') {
    const usage = await service.usageReport();
    return json({ ok: true, usage });
  }

  if (section === 'register' && method === 'POST') {
    const body = await readJsonBody(request);
    const result = await service.register(body);
    return json({ ok: true, user: result.user }, 201, { 'set-cookie': cookieValue(result.token) });
  }

  if (section === 'login' && method === 'POST') {
    const body = await readJsonBody(request);
    const result = await service.login(body);
    return json({ ok: true, user: result.user }, 200, { 'set-cookie': cookieValue(result.token) });
  }

  if (section === 'logout' && method === 'POST') {
    await service.logout(token);
    return json({ ok: true }, 200, { 'set-cookie': clearedCookie() });
  }

  if (section === 'password' && method === 'POST') {
    const body = await readJsonBody(request);
    const result = await service.changePassword(token, body);
    return json({ ok: true }, 200, { 'set-cookie': cookieValue(result.token) });
  }

  if (section === 'resources' && method === 'GET') {
    const result = await service.listResources(token, url.searchParams);
    return json({ ok: true, total: result.total, resources: result.resources });
  }

  if (section === 'resources' && id && method === 'PATCH') {
    const body = await readJsonBody(request);
    const resource = await service.updateResource(token, id, body);
    return json({ ok: true, resource });
  }

  if (section === 'resources' && id && method === 'DELETE') {
    await service.deleteResource(token, id);
    return json({ ok: true });
  }

  if (section === 'uploads' && parts.length === 2 && method === 'POST') {
    const body = await readJsonBody(request);
    const result = await service.startUpload(token, body);
    return json({ ok: true, ...result }, 201);
  }

  if (section === 'uploads' && id === 'part' && method === 'PUT') {
    const data = new Uint8Array(await request.arrayBuffer());
    const result = await service.uploadPart(token, {
      key: request.headers.get('x-r2-key') || '',
      uploadId: request.headers.get('x-upload-id') || '',
      partNumber: Number(request.headers.get('x-part-number')),
      partCount: Number(request.headers.get('x-part-count')),
      data,
    });
    return json({ ok: true, ...result });
  }

  if (section === 'uploads' && id === 'complete' && method === 'POST') {
    const body = await readJsonBody(request);
    const resource = await service.completeUpload(token, body);
    return json({ ok: true, resource }, 201);
  }

  if (section === 'uploads' && id === 'abort' && method === 'POST') {
    const body = await readJsonBody(request);
    await service.abortUpload(token, body);
    return json({ ok: true });
  }

  /* 预览：直接用图片本身的类型发给浏览器看，并且钉死几个响应头，
     免得有人把别的东西伪装成图片让浏览器执行。 */
  if (section === 'preview' && id && method === 'GET') {
    const { resource, object, contentType } = await service.preview(token, id);
    const headers = new Headers();
    headers.set('content-type', contentType);
    if (object && object.size) headers.set('content-length', String(object.size));
    headers.set('content-disposition', 'inline');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('content-security-policy', "default-src 'none'; sandbox");
    headers.set('cache-control', 'private, max-age=120');
    return new Response(object ? object.body : null, { status: 200, headers });
  }
  if (section === 'download' && id && method === 'GET') {
    const { resource, object } = await service.download(token, id);
    const headers = new Headers();
    headers.set('content-type', resource.mime || 'application/octet-stream');
    if (object && object.size) headers.set('content-length', String(object.size));
    headers.set('content-disposition',
      'attachment; filename="download"; filename*=UTF-8\'\'' + encodeURIComponent(resource.file_name));
    headers.set('cache-control', 'private, no-store');
    return new Response(object ? object.body : null, { status: 200, headers });
  }

  if (section === 'admin' && id === 'invites' && method === 'GET') {
    const invites = await service.listInvites(token);
    return json({ ok: true, invites });
  }

  /* 作废要排在新建前面：路径都是 /api/admin/invites，靠后面那段区分。 */
  if (section === 'admin' && id === 'invites' && parts[3] === 'revoke' && method === 'POST') {
    const body = await readJsonBody(request);
    const result = await service.revokeInvite(token, body.code);
    return json({ ok: true, ...result });
  }
  if (section === 'admin' && id === 'invites' && method === 'POST') {
    const body = await readJsonBody(request);
    const invite = await service.createInvite(token, body);
    return json({ ok: true, invite }, 201);
  }

  if (section === 'admin' && id === 'usage' && method === 'GET') {
    const usage = await service.usageReport(token);
    return json({ ok: true, usage });
  }

  if (section === 'admin' && id === 'users' && method === 'GET') {
    const users = await service.listUsers(token);
    return json({ ok: true, users });
  }

  return json({ ok: false, error: '没有这个接口' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return fail(err);
      }
    }
    /* 其余路径交给静态资源；public/ 里的文件由 Cloudflare 直接发出去。 */
    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
