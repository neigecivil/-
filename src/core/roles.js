'use strict';

/* 角色与权限：纯规则，不碰数据库、不碰网络。
   整套权限判断都从这里出，避免散落在各个接口里。 */

const ROLES = ['admin', 'member', 'guest'];

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
    seeMembersOnly: true,
  },
  member: {
    upload: true,
    createInvite: false,
    manageUsers: false,
    deleteOwnResource: true,
    deleteAnyResource: false,
    seeMembersOnly: true,
  },
  /* 游客是只读的。即使名下还有从前的文件，也不能自己删。 */
  guest: {
    upload: false,
    createInvite: false,
    manageUsers: false,
    deleteOwnResource: false,
    deleteAnyResource: false,
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

/* 能不能删。自己传的可以删，管理员可以删任何人的。 */
function canDelete(role, user, resource) {
  if (!user || !resource) return false;
  if (can(role, 'deleteAnyResource')) return true;
  if (!can(role, 'deleteOwnResource')) return false;
  return resource.ownerId === user.id;
}

module.exports = { ROLES, VISIBILITIES, RULES, isRole, can, canSee, canDelete };
