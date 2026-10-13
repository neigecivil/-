'use strict';

/* 资源领域：分类、平台、可见性、校验、展示形态、排序。
   和本机版保持一致的字段，多了 visibility（游客能不能看到）。 */

import { badRequest } from './errors.js';

const CATEGORIES = [
  { id: 'doc', name: '文档' },
  { id: 'software', name: '软件' },
  { id: 'design', name: '素材' },
  { id: 'course', name: '教程' },
  { id: 'video', name: '影音' },
  { id: 'other', name: '其他' },
];

const PLATFORMS = [
  { id: 'pc', name: '电脑端' },
  { id: 'mobile', name: '手机端' },
];

const VISIBILITIES = [
  { id: 'public', name: '所有人' },
  { id: 'members', name: '登录可见' },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
const PLATFORM_IDS = PLATFORMS.map((p) => p.id);
const VISIBILITY_IDS = VISIBILITIES.map((v) => v.id);
const PLATFORM_CATEGORY = 'software';
const SORTS = ['new', 'name', 'size', 'downloads'];

function normalizePlatform(category, raw) {
  if (category !== PLATFORM_CATEGORY) return '';
  const value = String(raw || '').trim();
  return PLATFORM_IDS.includes(value) ? value : '';
}

function validateMeta(input) {
  const title = String(input.title || '').trim();
  if (!title) throw badRequest('请先给这份资源起个标题');
  if (title.length > 80) throw badRequest('标题请控制在 80 个字以内');

  const category = CATEGORY_IDS.includes(input.category) ? input.category : 'other';
  const visibility = VISIBILITY_IDS.includes(input.visibility) ? input.visibility : 'public';

  return {
    title,
    description: String(input.description || '').trim().slice(0, 600),
    category,
    platform: normalizePlatform(category, input.platform),
    visibility,
  };
}

function nameOf(list, id, fallback) {
  const found = list.find((x) => x.id === id);
  return found ? found.name : fallback;
}

const categoryName = (id) => nameOf(CATEGORIES, id, '其他');
const platformName = (id) => nameOf(PLATFORMS, id, '');
const visibilityName = (id) => nameOf(VISIBILITIES, id || 'public', '所有人');

function humanSize(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

/* 只把客户端需要知道的字段送出去，R2 的对象键不出现在这里。 */
function present(resource, viewer) {
  return {
    id: resource.id,
    title: resource.title,
    description: resource.description || '',
    category: resource.category,
    categoryName: categoryName(resource.category),
    platform: resource.platform || '',
    platformName: platformName(resource.platform),
    visibility: resource.visibility || 'public',
    visibilityName: visibilityName(resource.visibility),
    fileName: resource.file_name,
    fileSize: humanSize(resource.file_size),
    owner: resource.owner_name || '',
    mine: !!(viewer && viewer.id === resource.owner_id),
    downloads: Number(resource.downloads || 0),
    createdAt: resource.created_at,
  };
}

function sortList(list, sort, viewer) {
  const by = SORTS.includes(sort) ? sort : 'new';
  const copy = list.slice();
  if (by === 'name') {
    return copy.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-CN'));
  }
  if (by === 'size') return copy.sort((a, b) => Number(b.file_size) - Number(a.file_size));
  if (by === 'downloads') return copy.sort((a, b) => Number(b.downloads || 0) - Number(a.downloads || 0));
  return copy.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export {
  CATEGORIES, PLATFORMS, VISIBILITIES,
  CATEGORY_IDS, PLATFORM_IDS, VISIBILITY_IDS, PLATFORM_CATEGORY, SORTS,
  validateMeta, normalizePlatform, categoryName, platformName, visibilityName,
  humanSize, present, sortList,
};
