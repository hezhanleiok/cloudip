# Changelog

## 1.2.0
- Added three deployment modes: installer, manual Worker, Pages Functions.
- Installer automatically creates/reuses D1 and injects `IOT_DB`, route and master key.
- Worker self-initializes D1 schema; no manual SQL for normal deployment.
- Hidden built-in ProxyIP/NAT64/Preferred-IP pools with custom override UI.
- CFnew IPDB sync + health testing.
- Per-user subscription tokens and subscription button.
- VLESS/Trojan WebSocket gateway with TCP outbound.
- Raw/Base64/Clash/Sing-box subscription endpoints.
