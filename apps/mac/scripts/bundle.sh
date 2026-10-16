#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
PACKAGE_DIR="$REPO_ROOT/apps/mac"
APP_NAME="Agni"
APP_BUNDLE="$PACKAGE_DIR/.build/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
ICON_ENTRY=""

swift build --package-path "$PACKAGE_DIR" --configuration release --product "$APP_NAME"
BIN_DIR=$(swift build --package-path "$PACKAGE_DIR" --configuration release --show-bin-path)

rm -rf "$APP_BUNDLE"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$BIN_DIR/$APP_NAME" "$CONTENTS/MacOS/$APP_NAME"

if [ -f "$REPO_ROOT/AgniBot-iOS-Default-1024@1x.png" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$PACKAGE_DIR/.build/Agni.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$REPO_ROOT/AgniBot-iOS-Default-1024@1x.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$REPO_ROOT/AgniBot-iOS-Default-1024@1x.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/Agni.icns"
  rm -rf "$ICONSET"
  ICON_ENTRY='  <key>CFBundleIconFile</key><string>Agni</string>'
fi

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Agni</string>
${ICON_ENTRY}
  <key>CFBundleIdentifier</key><string>dev.agni.mac</string>
  <key>CFBundleName</key><string>Agni</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "Built $APP_BUNDLE"
