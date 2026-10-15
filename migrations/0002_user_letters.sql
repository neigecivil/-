/* 资源分享站 · 第二批改动：账号自己挑的背景字母
   用法：在 Cloudflare 控制台的 D1 页面里执行本文件内容。

   注意：本文件只用块注释，不用行注释（理由见 0001_init.sql）。

   如果提示 duplicate column name，说明这一列已经加过了，可以忽略。 */

ALTER TABLE users ADD COLUMN bg_letters TEXT;