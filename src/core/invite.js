'use strict';

/* 邀请码：纯逻辑。
   随机源从外面传进来，测试时才能给出确定的结果。 */

/* 去掉了容易看错的 0/O、1/I/L，避免抄错。 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 10;
const GROUP = 5;

function generateCode(randomValues) {
  const bytes = randomValues || [];
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    /* 取模会有轻微偏斜，对邀请码来说无所谓。 */
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/* 用户可能输入小写、带空格、带横线，统一成存储格式。 */
function normalizeCode(input) {
  const text = String(input == null ? '' : input).toUpperCase().replace(/[^0-9A-Z]/g, '');
  return text;
}

function formatCode(code) {
  const text = normalizeCode(code);
  const parts = [];
  for (let i = 0; i < text.length; i += GROUP) parts.push(text.slice(i, i + GROUP));
  return parts.join('-');
}

/* 数据库里的列名是下划线风格，代码里用的是驼峰。
   两边都可能传进来，这里统一成一套，免得哪边改了另一边悄悄失效。 */
function normalizeInvite(invite) {
  if (!invite) return null;
  const pick = (camel, snake) => (invite[camel] !== undefined ? invite[camel] : invite[snake]);
  return {
    code: invite.code,
    role: invite.role,
    maxUses: pick('maxUses', 'max_uses'),
    usedCount: pick('usedCount', 'used_count'),
    expiresAt: pick('expiresAt', 'expires_at'),
    revokedAt: pick('revokedAt', 'revoked_at'),
  };
}

/* 判断一个邀请码还能不能用。 */
function checkInvite(input, now) {
  const at = typeof now === 'number' ? now : Date.now();
  const invite = normalizeInvite(input);
  if (!invite) return { ok: false, reason: '没找到这个邀请码' };
  if (invite.revokedAt) return { ok: false, reason: '这个邀请码已经作废了' };
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= at) {
    return { ok: false, reason: '这个邀请码过期了' };
  }
  const maxUses = invite.maxUses == null ? 1 : Number(invite.maxUses);
  const used = Number(invite.usedCount == null ? 0 : invite.usedCount);
  if (used >= maxUses) return { ok: false, reason: '这个邀请码已经用完了' };
  if (!invite.role || !['admin', 'member', 'guest'].includes(invite.role)) {
    return { ok: false, reason: '这个邀请码的角色配置不对' };
  }
  return { ok: true, reason: '' };
}

export { ALPHABET, CODE_LENGTH, generateCode, normalizeCode, formatCode, normalizeInvite, checkInvite };
