#!/usr/bin/env bash
# =============================================================================
#  Ollama setup for the Job Assistant -- run this ON THE AI MACHINE (Linux/macOS).
#
#  Same job as ollama-setup.cmd: install Ollama, make it listen on the network
#  rather than only on loopback, pull a model sized to the machine's RAM, and
#  print the OLLAMA_BASE_URL to paste into the app's .env.
#
#  Usage:   sudo bash ollama-setup.sh [model]
#  Example: sudo bash ollama-setup.sh qwen2.5:14b
# =============================================================================
set -euo pipefail

echo
echo "==== Job Assistant :: Ollama setup ========================================"
echo

# --- 1. Install ---------------------------------------------------------------
if command -v ollama >/dev/null 2>&1; then
  echo "[1/5] Ollama is already installed -- skipping the download."
else
  echo "[1/5] Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

# --- 2. Listen on the LAN -----------------------------------------------------
# Ollama binds 127.0.0.1 by default, which is useless here: the app runs on a
# different machine. On systemd this belongs in a drop-in, so it survives both
# reboots and Ollama upgrades.
echo "[2/5] Binding Ollama to 0.0.0.0:11434..."
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ollama.service'; then
  mkdir -p /etc/systemd/system/ollama.service.d
  cat > /etc/systemd/system/ollama.service.d/override.conf <<'CONF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_KEEP_ALIVE=30m"
CONF
  systemctl daemon-reload
  systemctl restart ollama
else
  # macOS, or a non-systemd Linux: set it for the launchd/user session.
  launchctl setenv OLLAMA_HOST "0.0.0.0:11434" 2>/dev/null || true
  launchctl setenv OLLAMA_KEEP_ALIVE "30m" 2>/dev/null || true
  echo "      No systemd unit found. If Ollama is running, restart it now so it"
  echo "      re-reads OLLAMA_HOST (quit it from the menu bar and reopen)."
fi

# --- 3. Firewall: this subnet only -------------------------------------------
# The Ollama API has NO authentication. Anyone who can reach 11434 can use the
# model and read every prompt. Keep it to the local network.
echo "[3/5] Opening TCP 11434 to the local subnet only..."
if command -v ufw >/dev/null 2>&1; then
  SUBNET=$(ip route 2>/dev/null | awk '/ proto kernel scope link/ {print $1; exit}')
  ufw allow from "${SUBNET:-192.168.0.0/16}" to any port 11434 proto tcp || true
else
  echo "      No ufw here -- allow TCP 11434 from your LAN in whatever firewall you use."
fi

# --- 4. Pull a model that fits ------------------------------------------------
MODEL="${1:-}"
if [ -z "$MODEL" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    RAMGB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  else
    RAMGB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576 ))
  fi
  echo "      Detected roughly ${RAMGB} GB of RAM."
  if   [ "$RAMGB" -ge 32 ]; then MODEL="qwen2.5:14b"
  elif [ "$RAMGB" -ge 16 ]; then MODEL="qwen2.5:7b"
  else                           MODEL="llama3.2:3b"
  fi
fi

echo "[4/5] Pulling ${MODEL} -- this is the long step."
ollama pull "$MODEL"

# --- 5. Report ----------------------------------------------------------------
echo "[5/5] Verifying..."
ollama list
LANIP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LANIP" ] && LANIP=$(ipconfig getifaddr en0 2>/dev/null || echo "<this machine's IP>")

cat <<EOF

==== Done =================================================================

  On the machine that runs the Job Assistant, put this in its .env:

    AI_PROVIDER=ollama
    OLLAMA_BASE_URL=http://${LANIP}:11434
    OLLAMA_MODEL=${MODEL}

  Check it from that machine first:
    curl http://${LANIP}:11434/api/version

  Note: this port has no password. Keep it on your local network -- do not
  forward it through your router.

EOF
