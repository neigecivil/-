'use strict';

/* 在线预览：只认图片，而且类型由文件名决定，不信客户端报的 mime。
   这样别人没法把 .html 说成图片骗浏览器渲染，避免同源脚本注入。
   视频按需求不做预览。 */

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

function extensionOf(fileName) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(fileName || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

function imageTypeOf(fileName) {
  return IMAGE_TYPES[extensionOf(fileName)] || '';
}

function canPreview(fileName) {
  return !!imageTypeOf(fileName);
}

export { IMAGE_TYPES, imageTypeOf, canPreview };