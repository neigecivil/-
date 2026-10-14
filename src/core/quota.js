'use strict';

/* 每人配额：算清楚"这个人还能传多少"。
   和 guard.js 分工不同 —— guard 盯的是整个存储桶会不会碰免费额度，
   这里盯的是单个账号的额度，两道都要过。纯计算，不碰存储也不碰网络。 */

const DEFAULT_USER_LIMIT_BYTES = 1024 * 1024 * 1024;   // 每人 1 GB
const DEFAULT_WARN_PERCENT = 80;

function toBytes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/* 返回当前处于哪一档：ok / warn / blocked。管理员走 unlimited。 */
export function evaluateQuota(usedBytes, options) {
  const opts = options || {};
  const used = Math.max(0, toBytes(usedBytes, 0));

  if (opts.unlimited) {
    return {
      unlimited: true,
      usedBytes: used,
      limitBytes: 0,
      remainingBytes: null,
      percent: 0,
      level: 'ok',
      blocked: false,
      warning: false,
    };
  }

  const limitBytes = toBytes(opts.limitBytes, DEFAULT_USER_LIMIT_BYTES);
  const warnPercent = toBytes(opts.warnPercent, DEFAULT_WARN_PERCENT);
  const remainingBytes = Math.max(0, limitBytes - used);
  const percent = limitBytes > 0 ? Math.min(100, Math.round((used / limitBytes) * 100)) : 100;

  let level = 'ok';
  if (used >= limitBytes) level = 'blocked';
  else if (percent >= warnPercent) level = 'warn';

  return {
    unlimited: false,
    usedBytes: used,
    limitBytes,
    remainingBytes,
    percent,
    level,
    blocked: level === 'blocked',
    warning: level === 'warn',
  };
}

/* 还放得下这么大的一份吗。 */
export function canStoreMore(quota, sizeBytes) {
  if (!quota || quota.unlimited) return true;
  const size = Math.max(0, toBytes(sizeBytes, 0));
  return quota.usedBytes + size <= quota.limitBytes;
}

export const QUOTA_DEFAULTS = {
  limitBytes: DEFAULT_USER_LIMIT_BYTES,
  warnPercent: DEFAULT_WARN_PERCENT,
};