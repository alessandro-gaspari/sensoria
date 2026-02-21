#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="Sensoria Excel Processor"
ENTRYPOINT="sensoria_excel_gui_single.py"
BUNDLE_ID="com.sensoria.excelprocessor"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Errore: python3 non trovato. Installa Python 3 e riprova."
  exit 1
fi

if ! python3 -c "import PyInstaller" >/dev/null 2>&1; then
  echo "PyInstaller non trovato: provo a installarlo..."
  if ! python3 -m pip install --user pyinstaller; then
    echo "Errore: installazione di PyInstaller fallita."
    echo "Controlla la connessione internet e riprova con:"
    echo "python3 -m pip install --user pyinstaller"
    exit 1
  fi
fi

python3 -m PyInstaller \
  --noconfirm \
  --clean \
  --windowed \
  --name "$APP_NAME" \
  --osx-bundle-identifier "$BUNDLE_ID" \
  --hidden-import tkinter \
  --hidden-import tkinter.ttk \
  --hidden-import tkinter.filedialog \
  --hidden-import tkinter.messagebox \
  "$ENTRYPOINT"

echo "Build completata con PyInstaller."
echo "App disponibile in: $(pwd)/dist/$APP_NAME.app"
