#!/bin/sh
# Tworzy ~/Applications/OpenCode Models.app (do uruchamiania ze Spotlight lub Docka).
# Aplikacja startuje serwer w tle i otwiera przeglądarkę; jeśli serwer już działa, tylko otwiera stronę.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun)" || { echo "Nie znaleziono bun w PATH." >&2; exit 1; }
APP="$HOME/Applications/OpenCode Models.app"
LOG="$HOME/Library/Logs/opencode-openrouter-config.log"

mkdir -p "$HOME/Applications"
rm -rf "$APP"
# Serwer odpięty od skryptu (własne stdin/stdout), żeby aplikacja od razu się zamknęła.
osacompile -o "$APP" -e "do shell script \"cd '$DIR'; nohup '$BUN' server.ts < /dev/null >> '$LOG' 2>&1 &\""
# Bez ikony w Docku; zmiana Info.plist wymaga ponownego podpisu.
plutil -replace LSUIElement -bool true "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" 2>/dev/null

echo "Gotowe: $APP"
echo "Logi serwera: $LOG"
