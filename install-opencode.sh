#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
# 主仓脚本调用时通过 OPENCODE_CONFIG_DIR 决定目标目录
OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

# 1. 安装 npm 依赖
echo "[install] npm install in $ROOT"
(cd "$ROOT" && npm install --production 2>&1 | tail -1)

# 注意：Node ESM 不支持 npm link 的 bare import（仅 CJS 生效），所以不做
# 全局 link。自定义 workflow 脚本请用以下 two import 方式：
#   1) 脚本放在 $ROOT/workflows/ 下：import ... from "../lib/runner.mjs"
#   2) 脚本放在任意位置：用 OPENCODE_WORKFLOW_ROOT 环境变量（由本脚本注册到 shell）
# 详见 skills/workflow-usage/SKILL.md 的『编写自定义 workflow 脚本』章节。

# 2. 软链插件
OPENCODE_PLUGIN_DIR="$OPENCODE_CONFIG_DIR/plugins"
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
OPENCODE_SKILL_DIR="$OPENCODE_CONFIG_DIR/skills"
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

# 4. 注册 OPENCODE_WORKFLOW_ROOT 到 shell（供自定义 workflow 脚本引用 lib）
# 仅子仓根目录自身有意义；主仓调用时 OPENCODE_WORKFLOW_ROOT 同样指向本子仓。
ZSHRC="${ZSHRC:-$HOME/.zshrc}"
EXPORT_LINE="export OPENCODE_WORKFLOW_ROOT=\"$ROOT\""
if [ ! -f "$ZSHRC" ]; then
  echo "[skip] $ZSHRC not found, please export OPENCODE_WORKFLOW_ROOT manually"
elif grep -Fq "OPENCODE_WORKFLOW_ROOT=" "$ZSHRC"; then
  existing=$(grep "OPENCODE_WORKFLOW_ROOT=" "$ZSHRC" | head -1)
  if echo "$existing" | grep -Fq "\"$ROOT\""; then
    echo "[ok] OPENCODE_WORKFLOW_ROOT already set to $ROOT"
  else
    echo "[warn] OPENCODE_WORKFLOW_ROOT exists but points elsewhere; please verify"
    echo "       current: $existing"
    echo "       expected: $EXPORT_LINE"
  fi
else
  printf '\n# OPENCODE_WORKFLOW_ROOT (auto-registered by install-opencode.sh)\n%s\n' "$EXPORT_LINE" >> "$ZSHRC"
  echo "[linked] OPENCODE_WORKFLOW_ROOT=$ROOT registered in $ZSHRC"
fi

# 5. 输出信息
echo "[ok] workflow 模板目录: $ROOT/workflows/"
echo "[next] 重启 opencode 以加载 workflow-hint 插件和 workflow-usage skill"
