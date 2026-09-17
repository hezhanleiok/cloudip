# CloudIP Pages 部署

将 `functions/_worker.js` 放入 Pages Functions。需要在 Pages 项目设置中绑定 D1，变量名必须为 `IOT_DB`。不需要 KV。

首次运行若没有安装器注入的管理员密钥，访问 `/setup` 设置管理员密钥与随机后台路径。之后访问 `/{后台路径}/admin`。
