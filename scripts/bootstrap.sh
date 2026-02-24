#!/usr/bin/env bash
# FirstClaw Bootstrap Script (macOS / Linux)
# Usage: bash scripts/bootstrap.sh
#
# Ensures Node.js >= 22, pnpm, and project dependencies are installed,
# then builds the project. Does NOT require npm to be pre-installed.

set -euo pipefail

MIN_NODE_MAJOR=22
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

step()  { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ok()    { printf '    \033[32m[OK] %s\033[0m\n' "$*"; }
warn()  { printf '    \033[33m[!]  %s\033[0m\n' "$*"; }
err()   { printf '    \033[31m[ERR] %s\033[0m\n' "$*"; }

# ---------- 1. Node.js ----------
step "Checking Node.js ..."

node_ok=false
if command -v node &>/dev/null; then
    node_ver="$(node -v 2>/dev/null || true)"
    major="${node_ver#v}"
    major="${major%%.*}"
    if [ "$major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
        ok "Node.js $node_ver (>= $MIN_NODE_MAJOR)"
        node_ok=true
    else
        warn "Node.js $node_ver is too old (need >= $MIN_NODE_MAJOR)"
    fi
fi

if [ "$node_ok" = false ]; then
    step "Installing Node.js $MIN_NODE_MAJOR ..."

    if ! command -v fnm &>/dev/null; then
        echo "    Installing fnm (Fast Node Manager) ..."
        curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
        export PATH="$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
        eval "$(fnm env --shell bash 2>/dev/null || true)"
    fi

    if command -v fnm &>/dev/null; then
        fnm install "$MIN_NODE_MAJOR"
        fnm use "$MIN_NODE_MAJOR"
        fnm default "$MIN_NODE_MAJOR"
        eval "$(fnm env --shell bash 2>/dev/null || true)"
    elif [ -s "$HOME/.nvm/nvm.sh" ]; then
        echo "    Using existing nvm ..."
        # shellcheck disable=SC1091
        . "$HOME/.nvm/nvm.sh"
        nvm install "$MIN_NODE_MAJOR"
        nvm use "$MIN_NODE_MAJOR"
    else
        err "Could not install Node.js automatically."
        err "Please install Node.js >= $MIN_NODE_MAJOR manually:"
        err "  https://nodejs.org/en/download"
        exit 1
    fi

    node_ver="$(node -v 2>/dev/null || true)"
    if [ -z "$node_ver" ]; then
        err "Node.js installation failed. Please install manually."
        exit 1
    fi
    ok "Node.js $node_ver installed"
fi

# ---------- 2. pnpm ----------
step "Checking pnpm ..."

if command -v pnpm &>/dev/null; then
    pnpm_ver="$(pnpm -v 2>/dev/null || true)"
    ok "pnpm $pnpm_ver found"
else
    step "Installing pnpm ..."

    if command -v corepack &>/dev/null; then
        echo "    Enabling pnpm via corepack ..."
        corepack enable
        corepack prepare pnpm@latest --activate 2>/dev/null || true
    fi

    if ! command -v pnpm &>/dev/null; then
        echo "    Using pnpm standalone installer ..."
        curl -fsSL https://get.pnpm.io/install.sh | sh -
        export PNPM_HOME="$HOME/.local/share/pnpm"
        export PATH="$PNPM_HOME:$PATH"
    fi

    pnpm_ver="$(pnpm -v 2>/dev/null || true)"
    if [ -z "$pnpm_ver" ]; then
        err "pnpm installation failed."
        err "Manual install: https://pnpm.io/installation"
        exit 1
    fi
    ok "pnpm $pnpm_ver installed"
fi

# ---------- 3. Install dependencies ----------
step "Installing project dependencies (pnpm install) ..."

cd "$PROJECT_DIR"
pnpm install
ok "Dependencies installed"

# ---------- 4. Build ----------
step "Building project (pnpm build) ..."

cd "$PROJECT_DIR"
pnpm build
ok "Build complete"

# ---------- Done ----------
echo ""
echo -e "\033[32m============================================\033[0m"
echo -e "\033[32m  FirstClaw bootstrap complete!\033[0m"
echo -e "\033[32m============================================\033[0m"
echo ""
echo -e "\033[36mNext steps:\033[0m"
echo "  1. Run setup wizard:   pnpm firstclaw setup"
echo "  2. Start gateway:      pnpm firstclaw gateway run --force"
echo ""
