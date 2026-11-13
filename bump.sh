#!/bin/sh
# Give this release a new version number: file links change (so browsers fetch new files) and version.json
# tells already-open copies of the site to reload themselves.
V=$(date +%Y%m%d%H%M)
sed -i -E "s#\?v=[0-9]+#?v=$V#g; s#PDFOPENER_BUILD = \"[0-9]+\"#PDFOPENER_BUILD = \"$V\"#" index.html
printf '{"v":"%s"}\n' "$V" > version.json
echo "version $V"
