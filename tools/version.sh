#!/bin/sh
# Zählt die App-Version hoch und setzt Datum und Uhrzeit (deutsche Zeit).
# Aufruf aus dem Hauptverzeichnis: sh tools/version.sh
set -e
cd "$(dirname "$0")/.."
alt=$(sed -n "s/.*name: '\([0-9]*\)'.*/\1/p" version.js)
neu=$((alt + 1))
jetzt=$(TZ=Europe/Berlin date '+%Y-%m-%d %H:%M')
sed -i.bak "s/name: '[0-9]*', date: '[^']*'/name: '$neu', date: '$jetzt'/" version.js && rm -f version.js.bak
echo "Version $neu · $jetzt"
