# 把《六面》放到公网，让好友用网址进来

当前联机版是 `server.js`（Node，零依赖，HTTP + SSE + POST）。它已经绑定了 `0.0.0.0`、支持 `PORT` 环境变量、带 `/api/health`，可以直接上公网。

先选路线：

| 路线 | 适合 | 成本 | 缺点 |
|---|---|---|---|
| **A. Cloudflare Tunnel** | 今天就想让朋友玩，电脑可以常开 | 0 元 | 电脑/终端要一直开着；随机域名每次重启会变 |
| **B. Fly.io** | 想要稳定网址，不想管服务器 | 约 $2～5/月 | 要账号/信用卡 |
| **C. Render** | 部署最简单 | Starter 约 $7/月 | 免费套餐会休眠，SSE 会断 |
| **D. VPS + Caddy** | 想完全控制、用自己的域名 | $4～6/月 | 要会一点 Linux |
| **E. Render Free + 保活** | 没有信用卡、想先长期白嫖 | 0 元 | 15 分钟无请求会休眠，需要定时 ping；有 750 小时/月上限 |

> **如果目标是“电脑关机也能玩”，不要选 A。** A 的隧道跑在你的电脑上，电脑一关就断；选 B/C/D/E，把 `server.js` 放到一台 24/7 的云机器上。部署完成后，你的电脑可以完全关机。

---

## A. 最快：Cloudflare Tunnel（当前电脑直接开）

不用买域名、不用部署，几分钟就能给朋友一个 HTTPS 网址。

### Windows

```powershell
# 1. 安装 cloudflared
winget install --id Cloudflare.cloudflared

# 2. 终端 1：启动游戏服务器
cd C:\Users\DELL\Documents\deepseek-harness\default-workspace\dice-pvp-sim
node server.js

# 3. 终端 2：开隧道
cloudflared tunnel --url http://127.0.0.1:8788
```

终端 2 会打印一个网址，例如：

```
https://random-words-here.trycloudflare.com
```

把这个网址发给朋友即可。**电脑不能睡眠，两个终端都要开着**；关掉隧道网址就失效。

### 想要固定网址（推荐有域名的人）

1. 域名托管到 Cloudflare。
2. `cloudflared tunnel login`
3. `cloudflared tunnel create six-faces`
4. `cloudflared tunnel route dns six-faces game.example.com`
5. 在 `%USERPROFILE%\.cloudflared\config.yml` 写：

```yaml
tunnel: <你的 tunnel UUID>
credentials-file: C:\Users\DELL\.cloudflared\<UUID>.json
ingress:
  - hostname: game.example.com
    service: http://127.0.0.1:8788
  - service: http_status:404
```

6. `cloudflared tunnel run six-faces`

这样只要电脑和隧道开着，`https://game.example.com` 就一直是你的。

---

## B. 稳定：Fly.io（推荐，不想管服务器）

仓库里已经放了 `Dockerfile` 和 `fly.toml`。

```powershell
# 安装 flyctl
iwr https://fly.io/install.ps1 -useb | iex

fly auth signup   # 或 fly auth login

cd C:\Users\DELL\Documents\deepseek-harness\default-workspace\dice-pvp-sim
# 先把 fly.toml 里的 app 名改成全局唯一，例如 six-faces-yourname
fly launch --no-deploy
fly deploy

fly open      # 打开网址
fly logs      # 看日志
fly status
```

关键点：

- `auto_stop_machines = false`、`min_machines_running = 1`：SSE 和 30 秒计时需要机器一直醒着。
- 先只开 **1 个实例**：房间状态在内存里，多实例会分到不同机器。
- 自定义域名：`fly certs add game.example.com`，然后把 DNS 按提示指过去。

---

## C. 最简单：Render

1. 把 `dice-pvp-sim` 推到 GitHub。
2. Render → New → Web Service → 选这个仓库。
3. Runtime 选 **Docker**（会自动用 `Dockerfile`）。
4. Plan 选 **Starter**；免费套餐空闲会休眠，SSE 会断。
5. Health Check Path 填 `/api/health`。
6. Deploy，拿到 `https://xxx.onrender.com`。

仓库里的 `render.yaml` 也可以直接用 Blueprint 部署。

---

## E. 没卡：Render Free + UptimeRobot 保活

Render 免费 Web Service 通常不需要信用卡，但 **15 分钟没有请求会休眠**；SSE 一睡就断。用免费 UptimeRobot 定时 ping 可以把它叫醒/保活。

1. 把项目推到 GitHub（网页上传也行，不需要 git 命令）。
2. Render → New → Web Service → 连仓库。
3. Runtime 选 **Docker**。
4. Plan 选 **Free**。
5. Health Check Path 填 `/api/health`。
6. **不要设置 `PORT` 环境变量**；Render 会自动注入 `PORT`，`server.js` 会用它。
7. Deploy，拿到 `https://xxx.onrender.com`。
8. 注册 UptimeRobot（免费），新建 HTTP(s) 监控：
   - URL: `https://xxx.onrender.com/api/health`
   - 间隔: 5 分钟
   - 这样 Render 不会因为 15 分钟无请求而休眠。

注意：

- 免费额度约 **750 小时/月**；24/7 是 744 小时，刚好卡线。只开一个服务，别开多实例。
- 第一次访问/休眠后冷启动可能要几十秒。
- 没有持久磁盘，重启会丢正在进行的局。
- 有些地区/账号 Render 也可能要求绑卡；如果被要求，换 Koyeb Free、学生包或 VPS。

`render.yaml` 已经改成 `plan: free`，并去掉了写死的 `PORT`。

---

## D. 最稳：VPS + Caddy（自己的域名）

以 Ubuntu 24.04 为例：

```bash
# Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs caddy

# 放代码
sudo mkdir -p /opt/six-faces
sudo cp -r ./* /opt/six-faces/
sudo useradd -r -s /bin/false sixfaces
sudo chown -R sixfaces:sixfaces /opt/six-faces
```

`/etc/systemd/system/six-faces.service`：

```ini
[Unit]
Description=Six Faces
After=network.target

[Service]
WorkingDirectory=/opt/six-faces
ExecStart=/usr/bin/node server.js
Environment=PORT=8788
Restart=always
User=sixfaces

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now six-faces
```

`/etc/caddy/Caddyfile`：

```caddyfile
game.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8788 {
        flush_interval -1
    }
}
```

```bash
sudo systemctl reload caddy
sudo ufw allow 80,443/tcp
```

DNS 的 A 记录指向 VPS IP，Caddy 会自动申请 HTTPS。

### Nginx 版本

如果不用 Caddy：

```nginx
location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

**SSE 必须关缓冲**，否则战报/倒计时会卡住不更新。

---

## 好友专用：别让陌生人进

现在房间码是 4 位，别人拿到网址可以自己开房。三种做法：

1. **Cloudflare Access（推荐）**：给域名加 Zero Trust，只有你邀请的邮箱能进；朋友打开网址先收验证码。
2. **Caddy basic auth**：在 `Caddyfile` 里打开 `basic_auth`，给好友一个共享账号。
3. **应用层访问口令**：目前没做；需要的话我可以给 `server.js` 加一个 `ACCESS_CODE`，创建/加入房间时要求输入。

如果只是小范围朋友，Cloudflare Access 最省事，不用改代码。

---

## 状态与限制

- 房间状态在**内存**里：服务器重启/重新部署，正在进行的局会丢；朋友需要重开。
- 只跑 **1 个实例**；不要开 autoscaling。
- 30 秒计时器跑在服务器上；机器休眠会暂停，所以用 Fly 常驻或 VPS。
- 4 位房间码约 100 万种；公网长期开放建议加访问控制或更长房间码。

---

## 上线后自检

1. `https://你的域名/api/health` 返回 `{"ok":true,...}`。
2. 两个浏览器标签：一个创建，一个用房间码加入，2 人开始。
3. 刷新页面能自动重连。
4. 战报和倒计时是否实时更新（如果不更新，99% 是代理缓冲没关）。
5. 手机 4G 打开一次，确认不是只通局域网。

---

## 我可以继续帮你

- 把 `ACCESS_CODE` 访问口令加进服务器和页面。
- 加一个 `docker compose` 或一键部署脚本。
- 如果你有 Fly/Render/VPS 账号，我可以按你的平台把命令缩到最短。
