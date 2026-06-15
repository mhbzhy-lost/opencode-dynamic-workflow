#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
OPENCODE_PLUGIN_DIR="${OPENCODE_PLUGIN_DIR:-$HOME/.config/opencode/plugins}"
INTERACTIVE=true

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-interactive) INTERACTIVE=false; shift ;;
    --plugin-dir) OPENCODE_PLUGIN_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash install-opencode.sh [--no-interactive] [--plugin-dir <path>]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# 1. 安装 npm 依赖
echo "[install] npm install in $ROOT"
(cd "$ROOT" && npm install --production 2>&1 | tail -1)

# 2. 软链插件
mkdir -p "$OPENCODE_PLUGIN_DIR"
PLUGIN_SRC="$ROOT/plugins/workflow-hint.js"
PLUGIN_DST="$OPENCODE_PLUGIN_DIR/workflow-hint.js"

if [ ! -f "$PLUGIN_SRC" ]; then
  echo "[error] 插件文件不存在: $PLUGIN_SRC" >&2
  exit 1
fi

if [ -L "$PLUGIN_DST" ]; then
  existing_target=$(readlink "$PLUGIN_DST")
  if [ "$existing_target" = "$PLUGIN_SRC" ]; then
    echo "[ok] plugin 软链已存在且正确: $PLUGIN_DST"
  else
    rm "$PLUGIN_DST"
    ln -s "$PLUGIN_SRC" "$PLUGIN_DST"
    echo "[ok] plugin 软链已更新: $PLUGIN_DST -> $PLUGIN_SRC"
  fi
elif [ -f "$PLUGIN_DST" ]; then
  rm "$PLUGIN_DST"
  ln -s "$PLUGIN_SRC" "$PLUGIN_DST"
  echo "[ok] plugin 替换为软链: $PLUGIN_DST -> $PLUGIN_SRC"
else
  ln -s "$PLUGIN_SRC" "$PLUGIN_DST"
  echo "[ok] plugin 软链已创建: $PLUGIN_DST -> $PLUGIN_SRC"
fi

# 3. 输出信息
echo "[ok] workflow 模板目录: $ROOT/workflows/"
echo "[next] 重启 OpenCode 以加载 workflow-hint 插件"
