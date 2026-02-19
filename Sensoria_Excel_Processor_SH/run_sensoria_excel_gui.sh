#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Errore: python3 non trovato. Installa Python 3 e riprova."
  exit 1
fi

exec python3 sensoria_excel_gui.py
