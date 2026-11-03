# 部署到服务器

城市大富翁的联网服务器是一个 Node.js 程序，同一个端口上提供网页和联网连接（`/ws`）。下面以 Ubuntu 22.04 云服务器、直接用 8787 端口对外为例。

不需要域名，也不改动服务器上已有的 nginx 等服务。没有 HTTPS 时浏览器不让网页用剪贴板，「复制链接」会改成显示链接让人手动复制，其他功能都正常。

## 第一次安装

**1. 云控制台放行端口。** 在阿里云 ECS 的「安全组」里添加入方向规则：协议 TCP，端口 `8787`，来源 `0.0.0.0/0`。

**2. 登录服务器，下载代码并运行安装脚本：**

```sh
git clone --depth 1 https://github.com/jlw-qq/rich-game.git /tmp/rich-game-src
sudo bash /tmp/rich-game-src/deploy/install.sh
```

脚本会：

1. 安装 Node.js 22（NodeSource 官方 apt 源）和 git
2. 创建不能登录的专用用户 `richgame`
3. 把代码放到 `/opt/rich-game`，安装依赖并构建网页
4. 安装 systemd 服务 `rich-game`：开机自启，崩溃后自动重启，只能写 `/var/lib/rich-game`
5. 如果 ufw 防火墙已开启，放行 8787（没开启就不动它）
6. 访问 `http://127.0.0.1:8787/` 确认服务正常

看到「安装完成」后，用浏览器打开 `http://服务器公网IP:8787/`。

脚本可以重复运行。端口已被别的程序占用时会停下并提示；要换端口：`PORT=8788 sudo -E bash /tmp/rich-game-src/deploy/install.sh`（安全组也要放行新端口）。

**下载依赖太慢**（国内服务器常见）时用 npm 镜像：

```sh
NPM_REGISTRY=https://registry.npmmirror.com sudo -E bash /tmp/rich-game-src/deploy/install.sh
```

**服务器连不上 GitHub** 时，在自己电脑的项目目录里打包，上传后安装：

```sh
# 自己电脑上（项目目录）
git archive --format=tar.gz -o rich-game.tar.gz HEAD
scp rich-game.tar.gz 用户@服务器IP:/tmp/

# 服务器上
mkdir -p /tmp/rich-game-src && tar -xzf /tmp/rich-game.tar.gz -C /tmp/rich-game-src
sudo bash /tmp/rich-game-src/deploy/install.sh /tmp/rich-game.tar.gz
```

## 以后更新

```sh
sudo bash /opt/rich-game/deploy/update.sh                    # 从 GitHub 拉最新代码
sudo bash /opt/rich-game/deploy/update.sh /tmp/rich-game.tar.gz   # 用上传的代码包
```

新网页先构建到单独的目录，成功后才替换并重启；构建失败时旧版本照常运行。重启时正在进行的对局会断开几秒，房间存盘在 `/var/lib/rich-game/rooms`，玩家的页面会自动重连回原来的座位。

## 常用命令

| 做什么 | 命令 |
| --- | --- |
| 看运行状态 | `systemctl status rich-game` |
| 实时看日志 | `journalctl -u rich-game -f` |
| 重启 / 停止 | `sudo systemctl restart rich-game` / `sudo systemctl stop rich-game` |
| 不再开机自启 | `sudo systemctl disable rich-game` |
| 改端口等设置 | 编辑 `/etc/systemd/system/rich-game.service`，然后 `sudo systemctl daemon-reload && sudo systemctl restart rich-game` |

## 卸载

```sh
sudo systemctl disable --now rich-game
sudo rm /etc/systemd/system/rich-game.service && sudo systemctl daemon-reload
sudo rm -rf /opt/rich-game /var/lib/rich-game
sudo userdel richgame
```

Node.js 和 git 留着；不需要的话 `sudo apt remove nodejs`。

## 打不开时

1. 在服务器上 `curl -I http://127.0.0.1:8787/`：不通说明服务没起来，看 `journalctl -u rich-game -n 50`。
2. 服务器上通、外面打不开：多半是安全组没放行 8787，或 ufw 开着但没放行（`sudo ufw status`）。
3. 网页能打开但联机连不上：确认地址栏里的端口和服务端口一致；中间有代理或 CDN 的话，它要支持 WebSocket。

以后有了域名想用 HTTPS，可以在服务器上用 Caddy 或现有的 nginx 反向代理到 `127.0.0.1:8787`，同时在服务文件里把 `HOST` 改成 `127.0.0.1`、加上 `Environment=TRUST_PROXY=1`（见上一级的 README.md）。
