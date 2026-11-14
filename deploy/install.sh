#!/usr/bin/env bash
# Sudyar one-time server setup (Ubuntu 22.04 / 24.04). Run from the repo folder as root:
#   sudo bash deploy/install.sh
# It asks for: your domain, an email (for the HTTPS certificate), a web password, and the Digikala
# Self Token. Secrets are typed here on the server only; they are never printed and never leave it.
# Safe to run again: it never overwrites an existing .env value.
set -euo pipefail

cd "$(dirname "$0")/.."
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash deploy/install.sh"; exit 1; }
[ -f docker-compose.yml ] || { echo "Run this from the Sudyar folder."; exit 1; }

say() { printf '\n== %s\n' "$*"; }

say "1/6 Installing Docker (from Ubuntu's own packages)"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y docker.io docker-compose-v2 openssl ufw
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-v2

say "2/6 Checking access to Docker Hub"
# Docker Hub refuses many Iranian IPs. If the test pull fails, offer an Iranian mirror.
# UNVERIFIED: mirror availability changes; check the mirror's own site if it fails too.
if ! docker pull -q postgres:16 >/dev/null 2>&1; then
  echo "Docker Hub is not reachable from this server."
  read -r -p "Use the ArvanCloud mirror (https://docker.arvancloud.ir)? [y/N] " ans
  if [ "${ans,,}" = "y" ]; then
    mkdir -p /etc/docker
    if [ -s /etc/docker/daemon.json ]; then
      echo "/etc/docker/daemon.json already exists; add the mirror there by hand. Stopping."; exit 1
    fi
    printf '{\n  "registry-mirrors": ["https://docker.arvancloud.ir"]\n}\n' > /etc/docker/daemon.json
    systemctl restart docker
    docker pull -q postgres:16 >/dev/null || { echo "The mirror did not work either. Stopping."; exit 1; }
  else
    echo "Stopping. Choose a mirror and run again."; exit 1
  fi
fi

say "3/6 Firewall: only SSH, HTTP and HTTPS"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

say "4/6 Settings file (.env)"
[ -f .env ] || cp .env.example .env
chmod 600 .env

get()  { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true; }
put()  {  # put KEY VALUE: set only if empty or missing (never overwrite)
  local k="$1" v="$2"
  if [ -n "$(get "$k")" ]; then return; fi
  if grep -qE "^$k=" .env; then
    python3 - "$k" "$v" <<'PY'
import sys, pathlib
k, v = sys.argv[1], sys.argv[2]
p = pathlib.Path(".env")
lines = p.read_text().splitlines()
p.write_text("\n".join(f"{k}={v}" if l.startswith(k + "=") else l for l in lines) + "\n")
PY
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}

put POSTGRES_PASSWORD "$(openssl rand -hex 24)"
put WEB_SECRET_KEY "$(openssl rand -hex 32)"
put SUDYAR_TOKEN_KEY "$(openssl rand -base64 32 | tr '+/' '-_')"   # Fernet key for stored Service Hub tokens

if [ -z "$(get SUDYAR_DOMAIN)" ]; then
  read -r -p "Domain (example: app.sudyarapp.ir): " dom
  [[ "$dom" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "That is not a valid domain."; exit 1; }
  put SUDYAR_DOMAIN "$dom"
fi
if [ -z "$(get ACME_EMAIL)" ]; then
  read -r -p "Email for the HTTPS certificate: " mail
  [[ "$mail" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "That is not a valid email."; exit 1; }
  put ACME_EMAIL "$mail"
fi
if [ -z "$(get WEB_PASSWORD)" ]; then
  while true; do
    read -r -s -p "Web page password (at least 12 characters, hidden): " p1; echo
    read -r -s -p "Same password again: " p2; echo
    if [ "$p1" = "$p2" ] && [ "${#p1}" -ge 12 ] && [[ "$p1" != *[[:space:]\$\'\"\#\\]* ]]; then break; fi
    echo "Passwords differ, are shorter than 12, or use space \$ ' \" # or \\ . Try again."
  done
  put WEB_PASSWORD "$p1"
  unset p1 p2
fi
if [ -z "$(get DIGIKALA_SELF_TOKEN)" ]; then
  read -r -s -p "Digikala Self Token (hidden; Enter to skip for now): " tok; echo
  [ -n "$tok" ] && put DIGIKALA_SELF_TOKEN "$tok"
  unset tok
fi
chmod 600 .env

say "5/6 Folders"
mkdir -p data backups
chown -R 10001:10001 data
chmod 700 backups

say "6/6 Starting Sudyar (first time takes several minutes)"
docker compose -f docker-compose.yml -f deploy/docker-compose.server.yml up -d --build

dom="$(get SUDYAR_DOMAIN)"
cat <<EOF

Done.
- Open https://$dom (the certificate can take 1-2 minutes the first time).
- The domain's DNS "A" record must point to this server's IP, or HTTPS cannot start.
- Database backups: ./backups (one per day, kept 14 days).
- Update later:  git pull && docker compose -f docker-compose.yml -f deploy/docker-compose.server.yml up -d --build
EOF
[ -n "$(get DIGIKALA_SELF_TOKEN)" ] || echo "- Digikala token not set yet: put it in .env (DIGIKALA_SELF_TOKEN=...) and run the update line."
