#!/bin/bash
set -e

echo "🏗 Building web assets..."
npm run build

echo "📱 Syncing to iOS..."
npx cap sync ios

echo "🔌 Registering local plugins..."
node -e "
  const fs = require('fs');
  const path = 'ios/App/App/capacitor.config.json';
  const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!cfg.packageClassList.includes('QuickLookPlugin')) {
    cfg.packageClassList.push('QuickLookPlugin');
    fs.writeFileSync(path, JSON.stringify(cfg, null, '\t'));
  }
"

echo "🗜 Archiving..."
xcodebuild -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination generic/platform=iOS \
  -archivePath build/App.xcarchive \
  -allowProvisioningUpdates \
  archive

echo "📤 Exporting archive..."
xcodebuild -exportArchive \
  -archivePath build/App.xcarchive \
  -exportPath build/export \
  -exportOptionsPlist scripts/ExportOptions.plist \
  -allowProvisioningUpdates

echo "☁️ Uploading to TestFlight..."
xcrun altool --upload-app \
  -f build/export/App.ipa \
  -t ios \
  --apiKey AGJTR7VTGQ \
  --apiIssuer ecb228f7-5979-4d7c-bac2-64ce7f2106bc

echo "✅ Done! Build uploaded to TestFlight."
