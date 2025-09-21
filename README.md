# WiFi AutoLogin

Simple Chrome extension to auto-login captive portal Wi-Fi (default: http://172.16.2.1:1000).

## Features
- Save credentials locally (optional "Remember me")
- Auto-detect fields with Mapper
- Auto-login when captive portal appears
- Keeps retry/backoff friendly

## Installation (developer)
1. Clone repo or unzip package.
2. Open `chrome://extensions/` → enable Developer mode → Load unpacked → select this folder.
3. Test and debug.

## Usage (end users)
1. Click extension icon → enter login URL (default filled), username and password.
2. Check "Remember me" to persist locally.
3. The extension will attempt auto-login when the portal shows.

## Privacy
Credentials are stored locally if you opt in and are not sent to any server. See the extension's privacy policy for more information.

## Support
Contact: pulselabs.team@gmail.com
