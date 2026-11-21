#!/bin/sh
# 拡張機能「knowkin for Gemini」の zip を作り直す。ext/gemini を直したら manifest.json の version を上げてから、これを実行して一緒に上げる
# （みんなのパソコンの更新係は、GitHub の manifest.json の版が変わったときだけ入れ替える）
set -e
cd "$(dirname "$0")/.."
rm -f public/knowkin-gemini-ext.zip
(cd ext/gemini && zip -qr ../../public/knowkin-gemini-ext.zip .)
echo "public/knowkin-gemini-ext.zip を作りました（版 $(node -p "require('./ext/gemini/manifest.json').version")）"
