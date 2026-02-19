#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

python3 -m pip install --upgrade pip setuptools py2app
python3 setup_py2app.py py2app

echo "Build completata."
echo "App disponibile in: $(pwd)/dist/Sensoria Excel Processor.app"
