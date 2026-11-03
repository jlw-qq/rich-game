#!/usr/bin/env bash
# 城市大富翁：更新已安装的联网服务器。用 root 运行：
#
#   sudo bash /opt/rich-game/deploy/update.sh                    # 从 GitHub 拉最新代码
#   sudo bash /opt/rich-game/deploy/update.sh rich-game.tar.gz   # 用上传的代码包
#
# 新网页先构建到 dist.new，成功后再替换 dist 并重启服务；构建失败时旧版本照常运行。
# 重启时正在进行的对局会断开几秒，房间存在 /var/lib/rich-game，玩家的页面会自动重连回原座位。
set -euo pipefail

APP_DIR=/opt/rich-game
APP_USER=richgame
SERVICE=rich-game
ARCHIVE="${1:-}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash $0"
[[ -f /etc/systemd/system/$SERVICE.service ]] || die "还没有安装，请先运行 deploy/install.sh"
PORT="$(sed -n 's/^Environment=PORT=//p' /etc/systemd/system/$SERVICE.service)"
PORT="${PORT:-8787}"

as_app() { sudo -u "$APP_USER" env HOME="$APP_DIR" npm_config_cache="$APP_DIR/.npm" npm_config_update_notifier=false \
  npm_config_fund=false npm_config_audit=false ${NPM_REGISTRY:+npm_config_registry="$NPM_REGISTRY"} "$@"; }

say "更新代码"
before="$(as_app git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '代码包')"
if [[ -n "$ARCHIVE" ]]; then
  [[ -f "$ARCHIVE" ]] || die "找不到代码包：$ARCHIVE"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "$ARCHIVE" -C "$tmp"
  [[ -f "$tmp/package.json" && -f "$tmp/server/index.js" ]] || die "代码包里没有 package.json 和 server/index.js"
  # 覆盖源码，保留 node_modules 和 dist（稍后重新安装、构建）
  cp -a "$tmp/." "$APP_DIR/"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
elif [[ -d "$APP_DIR/.git" ]]; then
  as_app git -C "$APP_DIR" pull --ff-only
else
  die "$APP_DIR 不是 git 仓库（当初用代码包安装），请带上新的代码包：sudo bash $0 rich-game.tar.gz"
fi
after="$(as_app git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '代码包')"
echo "$before → $after"

say "安装依赖并构建（构建到 dist.new，失败不影响正在运行的版本）"
as_app bash -c "cd '$APP_DIR' && npm ci && rm -rf dist.new && npx vite build --outDir dist.new --emptyOutDir"
[[ -f "$APP_DIR/dist.new/index.html" ]] || die "构建失败，旧版本仍在运行"
rm -rf "$APP_DIR/dist.old"
[[ -d "$APP_DIR/dist" ]] && mv "$APP_DIR/dist" "$APP_DIR/dist.old"
mv "$APP_DIR/dist.new" "$APP_DIR/dist"

say "重启服务"
systemctl restart "$SERVICE"
for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.5
done
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
  printf '\n\033[1;32m更新完成（%s）。\033[0m\n' "$after"
else
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  die "重启后服务没有正常响应，上面是最近的日志。上一版网页在 $APP_DIR/dist.old"
fi
