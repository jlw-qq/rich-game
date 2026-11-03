#!/usr/bin/env bash
# 城市大富翁：在 Ubuntu 22.04 / 24.04 上第一次安装联网服务器。用 root 运行：
#
#   sudo bash install.sh              # 从 GitHub 拉代码
#   sudo bash install.sh rich-game.tar.gz   # 用本地上传的代码包（GitHub 连不上时）
#
# 做的事：装 Node.js 22 和 git → 建专用用户 richgame → 代码放到 /opt/rich-game 并构建 →
# 装 systemd 服务（开机自启、崩溃自动重启）→ ufw 已开启时放行 8787 → 检查服务是否正常。
# 不会改动 nginx 或其他已有服务。可以重复运行：已完成的步骤会跳过。
#
# 可选环境变量：
#   PORT=8787                                       游戏端口
#   REPO=https://github.com/jlw-qq/rich-game.git    代码仓库
#   NPM_REGISTRY=https://registry.npmmirror.com     npm 镜像（国内服务器下载依赖更快）
set -euo pipefail

PORT="${PORT:-8787}"
REPO="${REPO:-https://github.com/jlw-qq/rich-game.git}"
APP_DIR=/opt/rich-game
DATA_DIR=/var/lib/rich-game
APP_USER=richgame
SERVICE=rich-game
NODE_MAJOR=22
ARCHIVE="${1:-}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash $0"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "PORT 必须是 1–65535 的整数：$PORT"
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || die "只在 Ubuntu 上测试过，当前系统是 ${PRETTY_NAME:-未知}"
if [[ -n "$ARCHIVE" ]]; then
  [[ -f "$ARCHIVE" ]] || die "找不到代码包：$ARCHIVE"
  ARCHIVE="$(realpath "$ARCHIVE")"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 先读进来：用代码包安装时 /opt/rich-game 会被整个替换，脚本所在目录可能随之消失
SERVICE_TEMPLATE="$(cat "$SCRIPT_DIR/rich-game.service")" || die "找不到 $SCRIPT_DIR/rich-game.service"

say "检查磁盘空间"
# Node.js 约 100 MB，依赖和构建约 150 MB，再留些余量给房间存盘和日志
need_mb=600
for dir in / /var /opt; do
  free_mb="$(df -Pm "$dir" | awk 'NR==2{print $4}')"
  (( free_mb >= need_mb )) || die "$dir 所在磁盘只剩 ${free_mb} MB，至少要 ${need_mb} MB。先清理磁盘（见 deploy/README.md「磁盘满了」）"
done
echo "剩余空间够用"

say "检查端口 $PORT 有没有被占用"
if ss -ltnH "sport = :$PORT" | grep -q .; then
  if systemctl is-active --quiet "$SERVICE"; then
    echo "端口 $PORT 是已安装的 $SERVICE 服务在用，继续（会重新构建并重启）"
  else
    ss -ltnpH "sport = :$PORT" >&2
    die "端口 $PORT 已被其他程序占用。换一个端口：PORT=8788 sudo -E bash $0"
  fi
fi

say "安装 Node.js $NODE_MAJOR 和 git"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git
current_major=0
if command -v node >/dev/null; then current_major="$(node -p 'process.versions.node.split(".")[0]')"; fi
if (( current_major >= NODE_MAJOR )); then
  echo "已有 Node.js $(node -v)，跳过"
else
  # NodeSource 官方 apt 源（签名校验），不执行远程脚本
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
NODE_BIN="$(command -v node)" || die "Node.js 没有装上"
# apt 源更新失败时可能装成 Ubuntu 自带的旧版 Node（22.04 是 12.x），这里拦住
installed_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
(( installed_major >= NODE_MAJOR )) || die "装上的是 Node.js $("$NODE_BIN" -v)，需要 $NODE_MAJOR 或更新。多半是上面的 apt-get update 失败了，请先解决上面的报错"
command -v npm >/dev/null || die "没有 npm（NodeSource 的 nodejs 包自带 npm）"
echo "Node.js $("$NODE_BIN" -v)（$NODE_BIN），npm $(npm -v)"

say "创建专用用户 $APP_USER（不能登录）"
if id "$APP_USER" >/dev/null 2>&1; then
  echo "用户已存在，跳过"
else
  useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$DATA_DIR" "$DATA_DIR/rooms"

say "准备代码：$APP_DIR"
if [[ -n "$ARCHIVE" ]]; then
  # 代码包解压到临时目录，确认是本项目后再替换，房间存盘在 $DATA_DIR，不受影响
  tmp="$(mktemp -d)"
  tar -xzf "$ARCHIVE" -C "$tmp"
  [[ -f "$tmp/package.json" && -f "$tmp/server/index.js" ]] || die "代码包里没有 package.json 和 server/index.js，打包方式见 deploy/README.md"
  rm -rf "$APP_DIR"
  mv "$tmp" "$APP_DIR"
elif [[ -d "$APP_DIR/.git" ]]; then
  echo "已有代码，拉取最新版本"
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
else
  [[ ! -e "$APP_DIR" ]] || die "$APP_DIR 已存在但不是 git 仓库，请先确认里面的内容再删除"
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git clone --depth 1 "$REPO" "$APP_DIR" || die "从 GitHub 拉代码失败。可以在自己电脑上打包后上传，见 deploy/README.md"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "安装依赖并构建网页"
npm_env=(HOME="$APP_DIR" npm_config_cache="$APP_DIR/.npm" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false)
[[ -n "${NPM_REGISTRY:-}" ]] && npm_env+=(npm_config_registry="$NPM_REGISTRY")
sudo -u "$APP_USER" env "${npm_env[@]}" bash -c "cd '$APP_DIR' && npm ci && npm run build"
[[ -f "$APP_DIR/dist/index.html" ]] || die "构建失败：没有生成 dist/index.html"

say "安装 systemd 服务 $SERVICE"
sed -e "s|^Environment=PORT=.*|Environment=PORT=$PORT|" \
    -e "s|^ExecStart=/usr/bin/node |ExecStart=$NODE_BIN |" \
    <<<"$SERVICE_TEMPLATE" >/etc/systemd/system/$SERVICE.service
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

say "防火墙"
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow "$PORT/tcp" comment 'rich-game'
else
  echo "ufw 没有开启，跳过（云服务器还要在控制台的安全组里放行 TCP $PORT）"
fi

say "检查服务"
for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.5
done
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
  printf '\n\033[1;32m安装完成。\033[0m本机检查已通过，打开 http://<服务器公网 IP>:%s/ 就能玩。\n' "$PORT"
  echo "看日志：journalctl -u $SERVICE -f    以后更新：sudo bash $APP_DIR/deploy/update.sh"
else
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  die "服务没有正常响应，上面是最近的日志"
fi
