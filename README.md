# CloudIP 1.2.0

## 三种部署方式

### A. Nahan 式自动安装
打开 `installer/index.html`。输入 Cloudflare API Token。安装器自动读取账户、创建/复用 D1、生成管理员密钥和后台随机路径、上传完整 `worker.js` 并自动绑定 `IOT_DB`。正常安装不需要手动执行 SQL，也不需要在 Worker 设置中创建 ADMIN_PASSWORD/SESSION_SECRET。

### B. Cloudflare Worker 网页手动部署
把根目录完整 `worker.js` 粘贴到 Worker。D1 是 Cloudflare 的账户级绑定，Worker 源码本身不能凭空创建账户资源，所以网页手动模式必须绑定一个 D1，变量名 `IOT_DB`；不需要 KV，也不需要执行 SQL。首次运行没有注入密钥时访问 `/setup` 完成一次管理员初始化。

### C. Cloudflare Pages
把 `pages/` 目录用于 Pages，运行时文件为 `pages/functions/_worker.js`。Pages 运行时同样需要 D1 Binding `IOT_DB`；Worker 会自动建表，不需要手工 SQL。安装器创建的 D1 可以复用。

## 核心功能

- 每用户独立随机订阅 Token；后台提供“获取订阅”按钮。
- VLESS/Trojan WebSocket 服务端与 TCP 出站。
- Raw/Base64/Clash/Sing-box 订阅输出。
- 端口策略、用户流量上限、到期时间字段。
- 内置 ProxyIP、NAT64 和 CFnew IPDB 优选 IP；默认不把内置资源地址展开显示。
- 自定义资源是覆盖层；删除自定义值自动回到内置资源。
- ProxyIP/Preferred IP 实际 HTTP 探测，健康资源优先，失败资源降权。
- D1 自动初始化；无 KV 依赖。
- 15 分钟 Cron 自动同步、检测和维护。
