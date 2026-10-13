'use strict';

/* 角色与权限：纯规则，不碰数据库、不碰网络。
   整套权限判断都从这里出，避免散落在各个接口里。 */

/* 可以被邀请的角色。没有 anonymous —— 那是"没登录"，邀请不了。 */
const ROLES = ['admin', 'member', 'guest'];

/* 没登录的人。单独列出来，是因为它以前和 guest 混在一起，
   导致"邀请一个游客"和"不给账号"效果完全一样，那个选项等于没用。 */
const ANONYMOUS = 'anonymous';

/* 资源可见性：
   public  —— 游客也能下载
   members —— 只有成员和管理员能下载 */
const VISIBILITIES = ['public', 'members'];

const RULES = {
  admin: {
    upload: true,
    createInvite: true,
    manageUsers: true,
    deleteOwnResource: true,
    deleteAnyResource: true,
    editOwnResource: true,
    editAnyResource: true,
    seeMembersOnly: true,
  },
  member: {
    upload: true,
    createInvite: false,
    manageUsers: false,
    deleteOwnResource: true,
    deleteAnyResource: false,
    editOwnResource: true,
    editAnyResource: false,
    seeMembersOnly: true,
  },
  /* 游客只读：能看全部资源，不能上传，也不能删东西。 */
  guest: {
    upload: false,
    createInvite: false,
    manageUsers: false,
    deleteOwnResource: false,
    deleteAnyResource: false,
    editOwnResource: false,
    editAnyResource: false,
    seeMembersOnly: true,
  },
  /* 没登录：只能看标成「所有人可见」的资源。 */
  anonymous: {
    upload: false,
    createInvite: false,
    manageUsers: false,
    deleteOwnResource: false,
    deleteAnyResource: false,
    editOwnResource: false,
    editAnyResource: false,
    seeMembersOnly: false,
  },
};

function isRole(role) {
  return ROLES.includes(role);
}

function can(role, action) {
  const rule = RULES[role];
  return !!(rule && rule[action]);
}

/* 能不能看到这份资源。缺少 visibility 的旧数据按 public 处理。 */
function canSee(role, resource) {
  if (!resource) return false;
  const visibility = resource.visibility || 'public';
  if (visibility === 'public') return true;
  return can(role, 'seeMembersOnly');
}

/* 能不能改。自己传的可以改，管理员可以改任何人的。 */
function canEdit(role, user, resource) {
  if (!user || !resource) return false;
  if (can(role, 'editAnyResource')) return true;
  if (!can(role, 'editOwnResource')) return false;
  return resource.owner_id === user.id;
}

/* 能不能删。自己传的可以删，管理员可以删任何人的。 */
function canDelete(role, user, resource) {
  if (!user || !resource) return false;
  if (can(role, 'deleteAnyResource')) return true;
  if (!can(role, 'deleteOwnResource')) return false;
  return resource.ownerId === user.id;
}

export { ROLES, ANONYMOUS, VISIBILITIES, RULES, isRole, can, canSee, canEdit, canDelete };
