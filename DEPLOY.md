# 部署说明

服务跑在 Lightsail `ema-mgt` 上，与现有 `ema-mgt`（3000）并存，本服务用 **3100**。

- 域名：`https://reply-stats.tfoffices.com`（DNS A 记录已指向 `54.168.48.231`）
- 代码目录：`/opt/reply-stats`
- systemd：`reply-stats`
- 反向代理：nginx → `127.0.0.1:3100`
- CI/CD：推送到 `main` 后 GitHub Actions 跑测试并 `rsync` + `systemctl restart`

## 首次上线（已完成或按需重做）

1. DNS：`reply-stats.tfoffices.com` → 服务器公网 IP
2. 服务器上创建 `/opt/reply-stats/.env`（从 `.env.example` 复制），填入 Slack 凭证
3. 安装 nginx 站点与 Let's Encrypt 证书（见 `deploy/`）
4. `sudo systemctl enable --now reply-stats`
5. 在 Slack 应用后台把 Event / Command / OAuth URL 指到该域名，验证 Request URL

## GitHub Secrets（Deploy workflow）

| Secret | 值 |
|---|---|
| `DEPLOY_HOST` | `54.168.48.231` |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | Lightsail SSH 私钥全文 |

`.env` **不会**被 CI 覆盖；只在服务器上维护。

## 常用命令

```bash
ssh -i ~/.ssh/lightsail/ema-mgt-oa-key.pem ubuntu@54.168.48.231
sudo systemctl status reply-stats
sudo journalctl -u reply-stats -f
curl -fsS https://reply-stats.tfoffices.com/healthz
```
