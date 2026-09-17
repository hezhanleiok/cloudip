# CloudIP 1.2.0 部署说明

## 方案 1：Nahan 式一键安装（推荐）

1. 打开 `installer/index.html`。
2. 填 Cloudflare API Token；Account ID 可留空。
3. 输入 Worker 名称和 D1 名称；密码和后台路径留空则自动生成。
4. 点击“开始自动部署”。
5. 安装器会通过 Cloudflare API：读取账户 → 创建/复用 D1 → 生成后台路径/管理员密钥 → 上传完整 `worker.js` → 自动写入 `IOT_DB` D1 Binding。
6. 安装器会尝试读取 workers.dev 子域并显示最终后台地址。

如果浏览器直接打开本地 HTML 后 Cloudflare API 被浏览器策略阻止，先把 `installer/proxy-worker.js` 部署成一个临时 Worker，再把安装器中的 API 请求改成该代理地址。这个代理只转发 Cloudflare API，不保存 Token。

## 方案 2：Cloudflare Workers 网页粘贴

1. 新建 Worker。
2. 删除编辑器原代码。
3. 粘贴根目录 `worker.js` 的全部内容。
4. 在 Worker 设置中添加 D1 Binding：变量名必须是 `IOT_DB`。
5. **不需要 KV。**
6. **不需要运行 SQL。** Worker 第一次请求会自动创建/修复表结构。
7. 因为网页手动粘贴无法从 Worker 源码创建账户级 D1，所以 D1 Binding 这一步是 Cloudflare 平台本身的必要动作；这是与安装器模式不同的唯一关键差异。
8. 如果代码中的 `__ADMIN_ROUTE__` / `__MASTER_KEY__` 仍存在，访问 `/setup`，设置一次管理员密钥和随机后台路径。

## 方案 3：Cloudflare Pages

1. 使用 `pages/` 目录创建 Pages 项目。
2. Pages Functions 文件已经是 `pages/functions/_worker.js`。
3. 在 Pages 项目设置 → Functions/Bindings 中绑定 D1，变量名 `IOT_DB`。
4. 不需要 KV，不需要手工 SQL。
5. 首次运行仍可访问 `/setup` 完成管理员初始化。

## 订阅

创建用户后，后台“用户管理”中的“获取订阅”按钮会给出独立 URL。原始订阅：`/sub/TOKEN`；Clash：`/clash/TOKEN`；Sing-box：`/singbox/TOKEN`；Base64：`/base64/TOKEN`。

## 资源策略

内置 ProxyIP、NAT64、Preferred IP 不在正常后台页面展开成地址表。默认模式使用内置维护源；自定义值是覆盖层，清空后恢复内置。Preferred IP 从 CFnew IPDB 同步候选，再做实际 HTTP 探测；健康资源优先，失败资源降低优先级。15 分钟 Cron 会继续同步和检测。
