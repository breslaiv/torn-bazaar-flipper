#!/usr/bin/env bash
# Richtet die lokale Fassung auf einer frischen Ubuntu-Server-Installation ein.
#
# Was hier passiert, soll man vorher lesen koennen - deshalb ein Skript im
# Repository statt einer SSH-Sitzung, die keine Spur hinterlaesst. Eine
# Maschine, die von Hand eingerichtet wurde, kann man nicht wieder aufbauen;
# diese hier schon.
#
# Das Skript ist wiederholbar: jeder Schritt prueft erst, ob er noetig ist.
# Es installiert bewusst KEINEN NVIDIA-Treiber und KEIN Modell - beides
# braucht einen Blick auf die Maschine (Secure Boot, MOK-Dialog, welche
# Modelle ueberhaupt passen) und wird danach von Hand gemacht.
#
# Aufruf:  ./tools/setup-local.sh [--yes] [--port 8080] [--interval 30]

set -euo pipefail

PORT=8080
# Gemessen, nicht geraten: YATA rechnet hoechstens einmal je Minute neu (der
# kleinste beobachtete Abstand zwischen zwei Zeitstempeln ist exakt 60 s).
# 30 s haelt die doppelte Marge und verliert nichts; 60 s waeren zu langsam,
# weil eine Abfrage selbst mehrere Sekunden dauert.
INTERVAL=30
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)    ASSUME_YES=1; shift ;;
    --port)      PORT="$2"; shift 2 ;;
    --interval)  INTERVAL="$2"; shift 2 ;;
    -h|--help)   sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unbekannt: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Wer das Skript aufgerufen hat, nicht root: die Dienste sollen unter einem
# normalen Konto laufen und nur in ihr eigenes Datenverzeichnis schreiben.
RUN_USER="${SUDO_USER:-$USER}"
RUN_GROUP="$(id -gn "$RUN_USER")"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }

need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then return 0; fi
  command -v sudo >/dev/null || { echo "sudo fehlt und wir sind nicht root." >&2; exit 1; }
}

# ---------------------------------------------------------------- Plan zeigen

say "Was dieses Skript tut"
cat <<PLAN
  Verzeichnis   $REPO
  Dienstkonto   $RUN_USER:$RUN_GROUP
  Webserver     http://127.0.0.1:$PORT  (nur lokal, Zugriff von aussen via Tailscale)
  Sammler       alle $INTERVAL s nach data/local/stock.db

  1. Node 22+ sicherstellen (sonst Node 24 von NodeSource)
  2. Datenverzeichnis anlegen
  3. Zwei systemd-Units schreiben und starten
  4. Deckel-zu-Standby abschalten
  5. Akku-Ladeschwelle und NVIDIA-Lage nur PRUEFEN und berichten

  Nicht enthalten: NVIDIA-Treiber, Ollama, Modelle. Die kommen danach von
  Hand, weil sie einen Blick auf die Maschine brauchen.
PLAN

if [ "$ASSUME_YES" -ne 1 ]; then
  read -rp $'\nWeiter? [j/N] ' answer
  case "$answer" in [jJyY]*) ;; *) echo "Abgebrochen."; exit 0 ;; esac
fi

need_sudo
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

# ---------------------------------------------------------------------- Node

say "1. Node"
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }

if [ "$(node_major)" -ge 22 ]; then
  info "Node $(node -v) ist da — reicht für node:sqlite."
else
  info "Node fehlt oder ist zu alt — installiere Node 24 von NodeSource."
  # Ubuntu 24.04 liefert Node 18; node:sqlite gibt es erst ab 22.5.
  curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
  info "Node $(node -v) installiert."
fi

if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  warn "Unter Node 22 meldet node:sqlite eine Experimental-Warnung. Funktioniert, ist nur laut."
fi

# --------------------------------------------------------------- Verzeichnis

say "2. Datenverzeichnis"
install -d -o "$RUN_USER" -g "$RUN_GROUP" "$REPO/data/local"
info "$REPO/data/local"

# -------------------------------------------------------------------- Dienste

say "3. systemd-Units"

write_unit() {
  local name="$1"; shift
  local tmp; tmp="$(mktemp)"
  cat >"$tmp"
  if [ -f "/etc/systemd/system/$name" ] && cmp -s "$tmp" "/etc/systemd/system/$name"; then
    info "$name unverändert"
    rm -f "$tmp"
    return
  fi
  $SUDO install -m 0644 "$tmp" "/etc/systemd/system/$name"
  rm -f "$tmp"
  info "$name geschrieben"
}

# ProtectSystem=strict macht das ganze Dateisystem schreibgeschuetzt; nur
# data/local darf beschrieben werden. Ein Fehler im Sammler kann damit
# hoechstens die eigene Datenbank beschaedigen, nicht das Repository und
# nicht das System.
COMMON_HARDENING="NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$REPO/data/local
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes"

write_unit torn-collector.service <<UNIT
[Unit]
Description=Torn Bazaar Flipper — Vorratssammler
Documentation=file://$REPO/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$REPO
ExecStart=$(command -v node) tools/collect-local.mjs --interval $INTERVAL --db data/local/stock.db
# Die Quelle ist fremd und darf ausfallen: der Sammler bremst sich selbst ab
# und laeuft weiter. Stirbt der Prozess doch, kommt er zurueck.
Restart=always
RestartSec=30
$COMMON_HARDENING

[Install]
WantedBy=multi-user.target
UNIT

write_unit torn-web.service <<UNIT
[Unit]
Description=Torn Bazaar Flipper — lokaler Webserver
Documentation=file://$REPO/README.md
After=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$REPO
ExecStart=$(command -v node) tools/serve.mjs --port $PORT --host 127.0.0.1 --db data/local/stock.db
Restart=always
RestartSec=10
$COMMON_HARDENING

[Install]
WantedBy=multi-user.target
UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now torn-collector.service torn-web.service
info "gestartet — Log mit: journalctl -u torn-collector -f"

# ------------------------------------------------------------------- Deckel

say "4. Deckel zu"
LID_CONF=/etc/systemd/logind.conf.d/99-torn.conf
if [ -f "$LID_CONF" ]; then
  info "schon gesetzt"
else
  $SUDO install -d /etc/systemd/logind.conf.d
  printf '%s\n' \
    '# Der Laptop ist ein Server: zugeklappt soll er weitermessen.' \
    '[Login]' \
    'HandleLidSwitch=ignore' \
    'HandleLidSwitchExternalPower=ignore' \
    'HandleLidSwitchDocked=ignore' | $SUDO tee "$LID_CONF" >/dev/null
  $SUDO systemctl restart systemd-logind
  info "$LID_CONF geschrieben"
fi

# --------------------------------------------------------- Nur nachsehen

say "5. Was ich nur prüfen, aber nicht entscheiden kann"

# Akku: HP hat die Ladeschwelle erst spaeter breit ausgerollt. Wenn der Kernel
# sie nicht anbietet, ist das eine Abwaegung und keine Einstellung.
THRESHOLD=""
for path in /sys/class/power_supply/BAT*/charge_control_end_threshold; do
  [ -e "$path" ] && THRESHOLD="$path" && break
done
if [ -n "$THRESHOLD" ]; then
  info "Ladeschwelle einstellbar: $THRESHOLD (aktuell $(cat "$THRESHOLD"))"
  info "  auf 80% mit:  echo 80 | sudo tee $THRESHOLD"
else
  warn "Keine Ladeschwelle im Kernel. Prüf das BIOS (F10 → Power Management)."
  warn "Gibt es dort auch keine, ist Dauerladen bei einem Akku dieses Alters"
  warn "eine bewusste Entscheidung — kein Versehen."
fi

if command -v nvidia-smi >/dev/null; then
  info "NVIDIA-Treiber läuft:"
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader | sed 's/^/    /'
else
  warn "Kein NVIDIA-Treiber. Für die Quadro P1000:"
  warn "  sudo ubuntu-drivers install"
  warn "Danach neu starten und den blauen MOK-Dialog NICHT wegklicken —"
  warn "ohne eingetragenen Schlüssel startet das System ohne Treiber."
fi

if command -v ollama >/dev/null; then
  info "Ollama ist da: $(ollama --version 2>/dev/null | head -1)"
else
  info "Ollama noch nicht installiert. Das kommt, wenn der Treiber steht."
fi

# ------------------------------------------------------------------ Abschluss

say "Fertig"
cat <<NEXT
  Prüfen:     curl -s http://127.0.0.1:$PORT/health | head -c 300
  Zusehen:    journalctl -u torn-collector -f
  Dichte:     node tools/collect-local.mjs --stats
  Vom Handy:  Tailscale einrichten, dann http://<name>.ts.net:$PORT

  Der Webserver hört nur auf 127.0.0.1. Das ist Absicht: mit Tailscale
  darüber ist der Dienst für deine Geräte da und nicht für jeden im WLAN.
NEXT
