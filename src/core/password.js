'use strict';

/* 口令规则：纯函数，方便测试，也方便在接口层复用。 */

const MIN_LENGTH = 10;
const MAX_LENGTH = 200;

/* 只收最常见的那些。宁可短，也不要一份没人维护的长名单。 */
const WEAK = [
  'password', 'passw0rd', '123456', '1234567', '12345678', '123456789', '1234567890',
  'qwerty', 'qwertyuiop', 'abc123', '111111', '000000', 'iloveyou', 'admin', 'administrator',
  'letmein', 'welcome', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  'woaini', 'woaini1314', '5201314', 'a123456', 'qwe123', 'asd123', 'zxcvbnm',
];

function normalize(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/\s+/g, '');
}

/* 返回问题清单，空数组表示通过。
   一次性把所有问题都列出来，让用户一次改完，而不是改一个报一个。 */
function checkPassword(password, options) {
  const opts = options || {};
  const text = String(password == null ? '' : password);
  const problems = [];

  if (text.length < MIN_LENGTH) {
    problems.push('密码至少 ' + MIN_LENGTH + ' 个字符');
  }
  if (text.length > MAX_LENGTH) {
    problems.push('密码不要超过 ' + MAX_LENGTH + ' 个字符');
  }

  const flat = normalize(text);
  if (flat && WEAK.includes(flat)) {
    problems.push('这是常被猜到的密码，换一个');
  }
  if (flat && /^\d+$/.test(flat)) {
    problems.push('别全用数字，掺一点字母');
  }

  const username = normalize(opts.username);
  if (username.length >= 3 && flat && (flat.includes(username) || username.includes(flat))) {
    problems.push('密码里别放昵称');
  }

  return problems;
}

function isStrong(password, options) {
  return checkPassword(password, options).length === 0;
}

module.exports = { MIN_LENGTH, MAX_LENGTH, WEAK, checkPassword, isStrong };
