# 资源分享站 · 云端版

跑在 Cloudflare 上的资源分享站。账号用邀请码注册，区分管理员 / 成员 / 游客三种角色，
文件存在 R2，大文件走分块上传绕开请求体上限。

## 目录结构

```
资源分享站-cloudflare/
├─ wrangler.toml            部署配置（绑定了 R2 和 D1）
├─ migrations/
│  └─ 0001_init.sql         建表脚本
├─ src/
│  ├─ worker.js             HTTP 层：路由、Cookie、响应（待补）
│  ├─ core/                 业务逻辑，不依赖 Cloudflare
│  │  ├─ service.js         唯一的业务入口
│  │  ├─ roles.js           角色权限表
│  │  ├─ password.js        口令强度规则
│  │  ├─ invite.js          邀请码
│  │  ├─ loginGuard.js      登录失败锁定
│  │  ├─ uploads.js         分块上传规则
│  │  ├─ resources.js       分类、可见性、排序
│  │  └─ errors.js          业务异常
│  └─ store/
│     ├─ d1.js              D1 存储适配器（待补）
│     └─ memory.js          内存版，测试用
├─ public/
│  └─ index.html            前端页面（待补）
└─ tests/                   测试，运行 node --test
```

设计上有一条线：**`core/` 里不出现任何 Cloudflare 的东西**。
数据库和文件都被抽象成接口，所以整套逻辑在本地就能测，不用碰云端。

## 本地跑测试

```
node --test
```

不需要安装任何东西，用的是 Node 自带的测试器。

## 部署步骤

### 一、把代码放到 GitHub

最简单的方式是网页上传：打开 <https://github.com/new> 建一个空仓库（名字随意，
比如 `reshub`），**不要**勾选 "Add a README file"。建好后在仓库页面点
「uploading an existing file」，把本项目文件夹里的所有内容拖进去，提交。

### 二、在 Cloudflare 建两个存储

1. 打开 <https://dash.cloudflare.com>，左侧选 **R2**，创建一个存储桶，
   名字填 `reshub-files`
2. 左侧选 **Workers & Pages** → **D1**，创建一个数据库，名字填 `reshub`
3. 进入刚建好的 D1，打开 **Console**，把 `migrations/0001_init.sql` 的
   全部内容粘进去执行

### 三、建 Worker 并连上仓库

1. **Workers & Pages** → **Create** → **Connect to Git**
2. 选中刚才那个仓库
3. 构建设置保持默认，直接点 Deploy

### 四、配置绑定和密钥

进入这个 Worker 的 **Settings**：

1. **Bindings** 里加两项：
   - R2 bucket：变量名 `FILES`，选 `reshub-files`
   - D1 database：变量名 `DB`，选 `reshub`
2. **Variables and Secrets** 里加一个**加密**变量：
   - 名字 `BOOTSTRAP_CODE`，值自己想一个长一点的字符串

这个暗号是用来创建**第一个管理员**的，只能用一次，用过就失效。

### 五、开始用

访问 `https://<你的项目名>.<你的账号>.workers.dev`，点注册，
昵称随便填，密码自己定，**邀请码那一栏填你设的 `BOOTSTRAP_CODE`**。
注册完你就是管理员，之后可以在后台生成邀请码发给别人。

### 六、先把暗号删掉

确认第一个管理员建好之后，回到 Settings 把 `BOOTSTRAP_CODE` 删掉，避免被人利用。

## 角色说明

| | 管理员 | 成员 | 游客 |
| --- | --- | --- | --- |
| 上传文件 | ✓ | ✓ | ✗ |
| 下载公开资源 | ✓ | ✓ | ✓ |
| 下载「仅成员」资源 | ✓ | ✓ | ✗ |
| 删除自己的文件 | ✓ | ✓ | ✗ |
| 删除别人的文件 | ✓ | ✗ | ✗ |
| 生成邀请码 | ✓ | ✗ | ✗ |

游客是只读的：连自己名下从前的文件也不能删。

## 关于上传大小

经过 Cloudflare 的请求有大小上限（免费版 100MB），所以前端会把文件切成 25MB 一片
分开发送，在 R2 那边拼回去。这样单个文件可以远超 100MB。
