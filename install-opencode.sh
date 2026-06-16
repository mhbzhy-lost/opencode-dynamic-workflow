#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
# 默认目录：尊重 OPENCODE_CONFIG_DIR（用于非默认安装路径），否则用 ~/.config/opencode
OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
OPENCODE_PLUGIN_DIR="${OPENCODE_PLUGIN_DIR:-$OPENCODE_CONFIG_DIR/plugins}"
OPENCODE_SKILL_DIR="${OPENCODE_SKILL_DIR:-$OPENCODE_CONFIG_DIR/skills}"
INTERACTIVE=true

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-interactive) INTERACTIVE=false; shift ;;
    --plugin-dir) OPENCODE_PLUGIN_DIR="$2"; shift 2 ;;
    --skill-dir) OPENCODE_SKILL_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash install-opencode.sh [--no-interactive] [--plugin-dir <path>] [--skill-dir <path>]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# 1. 安装 npm 依赖
echo "[install] npm install in $ROOT"
(cd "$ROOT" && npm install --production 2>&1 | tail -1)

# 注意：Node ESM 不支持 npm link 的 bare import（仅 CJS 生效），所以不做
# 全局 link。自定义 workflow 脚本请用以下 two import 方式：
#   1) 脚本放在 $ROOT/workflows/ 下：import ... from "../lib/runner.mjs"
#   2) 脚本放在任意位置：
#      const { ... } = await import(\`\${process.env.CLAUDE_CONFIG_HOME}/vendor/opencode-dynamic-workflow/lib/runner.mjs\`)
# 详见 skills/workflow-usage/SKILL.md 的『编写自定义 workflow 脚本』章节。

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

# 3. 软链 skill
SKILL_NAME="workflow-usage"
SKILL_SRC="$ROOT/skills/$SKILL_NAME"
SKILL_DST="$OPENCODE_SKILL_DIR/$SKILL_NAME"

if [ ! -d "$SKILL_SRC" ]; then
  echo "[warn] skill 目录不存在: $SKILL_SRC（跳过 skill 注册）" >&2
else
  mkdir -p "$OPENCODE_SKILL_DIR"
  if [ -L "$SKILL_DST" ]; then
    existing_target=$(readlink "$SKILL_DST")
    if [ "$existing_target" = "$SKILL_SRC" ]; then
      echo "[ok] skill 软链已存在且正确: $SKILL_DST"
    else
      rm "$SKILL_DST"
      ln -s "$SKILL_SRC" "$SKILL_DST"
      echo "[ok] skill 软链已更新: $SKILL_DST -> $SKILL_SRC"
    fi
  elif [ -e "$SKILL_DST" ]; then
    rm -rf "$SKILL_DST"
    ln -s "$SKILL_SRC" "$SKILL_DST"
    echo "[ok] skill 替换为软链: $SKILL_DST -> $SKILL_SRC"
  else
    ln -s "$SKILL_SRC" "$SKILL_DST"
    echo "[ok] skill 软链已创建: $SKILL_DST -> $SKILL_SRC"
  fi
fi

# 4. 输出信息
echo "[ok] workflow 模板目录: $ROOT/workflows/"
echo "[next] 重启 OpenCode 以加载 workflow-hint 插件和 workflow-usage skill"
