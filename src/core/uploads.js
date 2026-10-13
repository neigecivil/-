'use strict';

/* 分块上传的规则：纯计算，不碰网络也不碰存储。
   为什么要分块：Cloudflare 对每个请求的体量有上限（免费版 100MB），
   切开就绕过去了；顺带也让换存储后端时不用改前端。 */

/* 两种后端对分片的要求不一样，规则放在这里，别散到别处：
   R2  —— 除最后一片外，每片至少 5MiB；单对象可到 5TiB
   KV  —— 单个值上限 25MiB；一次下载能读的分片数也有限 */
const BACKENDS = {
  r2: {
    partSize: 25 * 1024 * 1024,
    minPartSize: 5 * 1024 * 1024,
    maxPartSize: 5 * 1024 * 1024 * 1024,
    maxParts: 10000,
    maxFileSize: 5 * 1024 * 1024 * 1024 * 1024,
  },
  kv: {
    partSize: 2 * 1024 * 1024,
    minPartSize: 0,
    maxPartSize: 20 * 1024 * 1024,
    maxParts: 2000,
    maxFileSize: 4 * 1024 * 1024 * 1024,
  },
};

function rulesFor(backend) {
  return BACKENDS[backend] || BACKENDS.r2;
}

function extensionOf(fileName) {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(String(fileName || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

/* 对象键按上传者分目录，权限校验也就有据可依。 */
function buildKey(userId, resourceId, fileName) {
  return 'u/' + userId + '/' + resourceId + extensionOf(fileName);
}

/* 只有属于这个用户的对象键才允许操作。 */
function keyBelongsTo(key, userId) {
  return typeof key === 'string' && key.startsWith('u/' + userId + '/');
}

function planParts(fileSize, partSize, backend) {
  const rules = rulesFor(backend);
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: '文件大小不正确' };
  }
  if (size > rules.maxFileSize) {
    return { ok: false, reason: '文件太大了，当前存储放不下' };
  }
  const chunk = partSize || rules.partSize;
  const count = Math.max(1, Math.ceil(size / chunk));
  if (count > rules.maxParts) {
    return { ok: false, reason: '文件太大，分片数量超过上限' };
  }
  return { ok: true, partSize: chunk, partCount: count };
}

function validateParts(parts, fileSize, partSize, backend) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return { ok: false, reason: '没有收到分片信息' };
  }
  const rules = rulesFor(backend);
  const chunk = partSize || rules.partSize;
  const expected = Math.max(1, Math.ceil(Number(fileSize) / chunk));
  if (parts.length !== expected) {
    return { ok: false, reason: '分片数量对不上，可能有分片没传成功' };
  }
  const numbers = parts.map((p) => Number(p.partNumber)).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) return { ok: false, reason: '分片序号不连续' };
  }
  if (parts.length > 1 && parts.some((p) => !p.etag)) {
    return { ok: false, reason: '有分片缺少校验值' };
  }
  return { ok: true };
}

/* 分片大小是否合规：R2 有下限（最后一片除外），KV 只有上限。 */
function checkPartSize(size, partNumber, partCount, backend) {
  const rules = rulesFor(backend);
  const bytes = Number(size);
  if (bytes > rules.maxPartSize) {
    return { ok: false, reason: '单个分片太大，存储接受不了' };
  }
  const isLast = Number(partNumber) === Number(partCount);
  if (!isLast && bytes < rules.minPartSize) {
    return { ok: false, reason: '分片小于存储要求的最小值' };
  }
  return { ok: true };
}

export {
  BACKENDS, rulesFor,
  extensionOf, buildKey, keyBelongsTo, planParts, validateParts, checkPartSize,
};
