# Setup & Run on Android

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Java JDK 17+](https://www.oracle.com/java/technologies/downloads/)
- [Android Studio](https://developer.android.com/studio) (for Android SDK)
- Cordova: `npm install -g cordova`
- esbuild: `npm install -g esbuild`

Set `ANDROID_HOME` to your Android SDK path:
```
ANDROID_HOME=C:\Users\<you>\AppData\Local\Android\Sdk
```

---

## First-time setup

### 1. Clone the repo

```bash
git clone https://github.com/yannorth/Router C:\Projects\Router
```

### 2. Create `env.js` in the repo root

```js
window.APP_CONFIG = {
  MAPBOX_TOKEN: 'pk.your_token_here'
};
```

### 3. Bundle JS

```bash
esbuild C:\Projects\Router\app.js --bundle --outfile=C:\Projects\Router\app.bundle.js --format=iife
```

### 4. Create the Cordova project

```bash
mkdir C:\Projects\RouterApp
cd C:\Projects\RouterApp
cordova create . com.example.router Router
rmdir /S /Q www
```

> Run the next command as **Administrator**:

```bash
mklink /D C:\Projects\RouterApp\www C:\Projects\Router
```

### 5. Add Android platform

```bash
cd C:\Projects\RouterApp
cordova platform add android
```

### 6. Install plugins

```bash
cordova plugin add cordova-plugin-statusbar cordova-plugin-appavailability cordova-sqlite-storage cordova-plugin-geolocation cordova-plugin-file
```

---

## Run on device

Enable **USB debugging** on the device, connect via USB, verify with:

```bash
adb devices
```

Then:

```bash
cd C:\Projects\RouterApp && cordova run android --device
```

---

## Updating an existing installation (same signature)

```bash
cd C:\Projects\Router && git pull
esbuild C:\Projects\Router\app.js --bundle --outfile=C:\Projects\Router\app.bundle.js --format=iife
cd C:\Projects\RouterApp && cordova run android --device
```

---

## Updating an existing installation (different signature)

If the device already has the app installed with a different signature, you must uninstall first — but **backup the databases before uninstalling**.

### Step 1 — Backup databases

```bash
adb backup -noapk com.example.router -f router_backup.ab
```

Confirm the backup on the device when prompted. Check the file is not empty (should be several KB at least).

### Step 2 — Uninstall

```bash
adb uninstall com.example.router
```

### Step 3 — Build and install

```bash
cd C:\Projects\RouterApp && cordova run android --device
```

### Step 4 — Restore databases

```bash
adb restore router_backup.ab
```

Confirm the restore on the device when prompted.

> ⚠️ `adb backup` only works if the app was built with `android:allowBackup="true"`. If the backup file is smaller than 1KB, it captured nothing and the data cannot be recovered.
