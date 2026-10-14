# 资源分享站 · 云端版

跑在 Cloudflare 上的资源分享站。账号用邀请码注册，区分管理员 / 成员 / 游客三种角色，
文件存在 R2，大文件走分块上传绕开请求体上限。

## 目录结构

```
资源分享站-cloudflare/
├─ wrangler.toml            部署配置（绑定了 R2 和 D1）
├─ migrations/
│  └─ 0001_init.sql         建表脚本
├─ package.json             声明用 ES 模块
├─ src/
│  ├─ worker.js             HTTP 层：路由、Cookie、响应
│  ├─ core/                 业务逻辑，不依赖 Cloudflare
│  │  ├─ service.js         唯一的业务入口
│  │  ├─ roles.js           角色权限表
│  │  ├─ password.js        口令强度规则
│  │  ├─ invite.js          邀请码
│  │  ├─ loginGuard.js      登录失败锁定
│  │  ├─ uploads.js         分块上传规则
│  │  ├─ resources.js       分类、可见性、排序
│  │  └─ errors.js          业务异常
│  ├─ store/
│  │  ├─ d1.js              D1 存储适配器
│  │  └─ memory.js          内存版，测试用
│  └─ adapters/
│     ├─ r2.js              R2 文件读写（默认）
│     └─ kv.js              Workers KV 文件读写（备用）
├─ public/
│  └─ index.html            前端页面
├─ tools/
│  └─ dev.mjs               本地预览服务器
└─ tests/                   测试，运行 node --test
```

设计上有一条线：**`core/` 里不出现任何 Cloudflare 的东西**。
数据库和文件都被抽象成接口，所以整套逻辑在本地就能测，不用碰云端。

## 本地跑测试

```
node --test
```

不需要安装任何东西，用的是 Node 自带的测试器。

## 先在本地看一眼

不用部署到 Cloudflare 也能把整站跑起来：

```
node tools/dev.mjs
```

然后打开 <http://127.0.0.1:4330>。第一次注册时，邀请码填 `LOCAL-DEV-CODE`。

账号和文件都留在项目里的 `.devdata/`，**重启不用重新注册**，登录状态也还在。
想清空重来：

```
set RESHUB_DEV_RESET=1 && node tools/dev.mjs
```

清掉之后重新注册一次就行（还是那个邀请码）。`.devdata/` 已经在 `.gitignore` 里，不会被提交。
想在本地看"存储快满了"那条提醒，把额度调小再启动：

```
set STORAGE_LIMIT_MB=1 && set STORAGE_WARN_PERCENT=1 && node tools/dev.mjs
```

（`USER_QUOTA_MB`、`STORAGE_RESERVE_MB`、`GUARD_BLOCK_DOWNLOADS` 同样可以直接这样传。）

这条路和线上唯一的差别是 Cookie 去掉了 Secure 标记（本地是 http）。

## 部署步骤

### 一、把代码放到 GitHub

最简单的方式是网页上传：打开 <https://github.com/new> 建一个空仓库（名字随意，
比如 `reshub`），**不要**勾选 "Add a README file"。建好后在仓库页面点
「uploading an existing file」，把本项目文件夹里的所有内容拖进去，提交。

### 二、在 Cloudflare 建两个存储

1. 打开 <https://dash.cloudflare.com>，左侧 **Storage & databases** 里选 **R2**，
   创建一个存储桶，名字填 `reshub-files`
   - 注意：开通 R2 需要先绑定支付方式。免费额度内不会扣费（每月 10GB 存储、
     100 万次写入、1000 万次读取，流量免费），但**不想绑卡就用下面的 KV 方案**
2. 同样在 **Storage & databases** 里选 **D1**，创建一个数据库，名字填 `reshub`
3. 进入刚建好的 D1，打开 **Console**，把 `migrations/0001_init.sql` 的
   全部内容粘进去执行

<details>
<summary><strong>不想绑卡？用 KV 代替 R2</strong></summary>

Workers KV 属于免费计划，不需要支付方式。

1. 在 **Storage & databases** 里选 **Workers KV**，创建一个命名空间，
   名字填 `reshub-files`
2. 把 `wrangler.toml` 里 `[[r2_buckets]]` 那一段注释掉，
   把下面的 `[[kv_namespaces]]` 那一段取消注释
3. 第四步绑定时，绑定 KV 命名空间而不是 R2 存储桶
4. 再加一个变量 `FILE_BACKEND`，值填 `kv`

代价：总共 1GB 存储，单个文件建议不超过 50MB。

</details>

### 三、建 Worker 并连上仓库

1. **Workers & Pages** → **Create** → **Connect to Git**
2. 选中刚才那个仓库
3. 构建设置保持默认，直接点 Deploy

### 四、配置绑定和密钥

进入这个 Worker 的 **Settings**：

1. **Bindings** 里加两项：
   - R2 bucket（用 KV 方案的话选 KV namespace）：变量名 `FILES`，选 `reshub-files`
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

| | 管理员 | 成员 | 游客 | 没登录 |
| --- | --- | --- | --- | --- |
| 看「所有人可见」的资源 | ✓ | ✓ | ✓ | ✓ |
| 看「登录可见」的资源 | ✓ | ✓ | ✓ | ✗ |
| 上传文件 | ✓ | ✓ | ✗ | ✗ |
| 编辑自己的资源 | ✓ | ✓ | ✗ | ✗ |
| 编辑任何人的资源 | ✓ | ✗ | ✗ | ✗ |
| 删除自己的文件 | ✓ | ✓ | ✗ | ✗ |
| 删除别人的文件 | ✓ | ✗ | ✗ | ✗ |
| 生成邀请码 | ✓ | ✗ | ✗ | ✗ |

游客是只读的：能看全部资源，但不能上传，也不能删东西。

## 用量保护（防止产生费用）

Cloudflare 的免费额度是 R2 每月 10GB 存储。填满之后按 $0.015/GB 收费。
为了避免在不知情的情况下产生账单，代码里做了保护：

- **用到 80%** —— 所有人（含没登录的）都会在页面上方看到提醒条
- **顶到上限（10GB − 200MB 预留）** —— 自动停止上传，提示用户空间已满
- **同时**（默认）也停止对外下载。管理员不受限，方便取回文件、清理空间
- 删掉一些资源腾出空间后，自动恢复

那 200MB 是特意留的缓冲，避免刚好卡在额度边界上。

参数可以在 Cloudflare 的 **Settings → Variables and secrets** 里调（都是可选的）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `STORAGE_LIMIT_MB` | `10240` | 总额度，默认 10GB |
| `STORAGE_RESERVE_MB` | `200` | 预留缓冲 |
| `STORAGE_WARN_PERCENT` | `80` | 到几成开始提醒 |
| `GUARD_BLOCK_DOWNLOADS` | `true` | 满了要不要连下载也停。填 `false` 就只停上传 |
| `USER_QUOTA_MB` | `1024` | 每个成员自己的上传额度（默认 1GB）。管理员不受限 |

**为什么盯住存储量就够了**：R2 的免费额度是 10 GB-月，而 GB-月是"占用大小 × 占用时间"的积分。
只要任何时刻的占用都不超过 10GB，一个月累计下来就不可能超。所以看当前占用是有效且最紧的判据。

**关于下载**：Cloudflare 的流量（出口带宽）完全免费，R2 读取是每月 1000 万次免费，
一般用不到。停下载主要是"保险"，嫌影响使用就把 `GUARD_BLOCK_DOWNLOADS` 设成 `false`。

## 每个人自己的额度

除了整站那份免费额度，每个人还有一份自己的上传额度，默认 1GB（`USER_QUOTA_MB` 可调）。
**管理员不受这个限制**，他是来管事的。

- 额度按这个人所有资源的大小实时算出来，删掉自己的文件就腾出来了
- 开始上传前先按大小预判，传完再按真实大小复核，前端少报也绕不过去
- 用到八成，页面上方出现提醒条；用满变红，再传就会被挡住，并告诉你还剩多少
- 立这条规矩之前已经传上去的东西一份都不动，只是不能再传新的

## 邀请码作废

管理面板的邀请码列表里，还能用的码后面有个「作废」按钮。点一下确认，这个码立刻失效，
注册时会提示「这个邀请码已经作废了」。已经用掉的码不会受影响。

## 图片预览

图片可以直接在页面上看，不用先下载。视频不做预览。

只有图片会给「预览」按钮，而且类型由服务端按文件名判定，不信客户端报的 mime ——
不然有人把网页文件说成图片，浏览器就会在本站域名下把它当页面执行。

## 关于上传大小

经过 Cloudflare 的请求有大小上限（免费版 100MB），所以前端会把文件切成小块分开发送，
在存储那边拼回去。前端一次并发 4 路，分片直接以 Blob 交给 fetch，不先在内存里攒整块。这样单个文件可以远超 100MB。

分片大小跟着存储后端走：R2 用 25MB（R2 要求除最后一片外每片不小于 5MB），
KV 用 2MB（KV 单个值上限 25MB）。前端不需要知道这些，服务端会告诉它。

