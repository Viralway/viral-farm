# Getting started

From an empty Mac to a registered iPhone running its first scheduled task.

<p>
  <a href="#1-prepare-the-mac">1. Mac</a> ·
  <a href="#2-pair-the-iphone">2. iPhone</a> ·
  <a href="#3-install">3. Install</a> ·
  <a href="#4-configure">4. Configure</a> ·
  <a href="#5-database">5. Database</a> ·
  <a href="#6-build-webdriveragent">6. WebDriverAgent</a> ·
  <a href="#7-run">7. Run</a> ·
  <a href="#8-register-and-schedule">8. Register</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## What you need

| Requirement | Why |
| --- | --- |
| macOS with the full Xcode | Builds, signs and launches WebDriverAgent on a real device |
| Node.js 22+ | The server runs TypeScript directly through `tsx` |
| PostgreSQL 14+ | Schedules, executions, logs and the job queue. A `docker compose` service is bundled |
| An Apple Developer team | Signs WebDriverAgent. A free personal team covers one device; a paid team is needed for more |
| A physical iPhone | Trusted, in Developer Mode, connected by USB |

---

## 1. Prepare the Mac

Install the full Xcode from the App Store (not just the Command Line Tools), open it once, then:

```sh
sudo xcodebuild -license accept
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -runFirstLaunch
xcode-select -p        # must print …/Xcode.app/Contents/Developer
```

Add your Apple ID in Xcode → Settings → Accounts and note the ten-character **Team ID**. You will need it in step 4.

---

## 2. Pair the iPhone

1. Connect by USB, unlock, tap **Trust This Computer** and enter the passcode.
2. In Xcode → Window → Devices and Simulators, wait until the device reads **Connected**. Xcode is mounting the Developer Disk Image in the background.
3. On the phone, enable Settings → Privacy & Security → **Developer Mode**, restart, confirm. The toggle appears only after the first pairing with Xcode.

Confirm the toolchain sees it:

```sh
xcrun xctrace list devices     # your iPhone must be under "Devices", not "Devices Offline"
```

---

## 3. Install

```sh
git clone <this-repo> viral-farm
cd viral-farm
npm install
npm run appium:install-driver   # pins the XCUITest driver into ./.appium2
```

---

## 4. Configure

```sh
cp .env.example .env
```

Set these five keys. Everything else has a working default.

| Key | Value |
| --- | --- |
| `XCODE_ORG_ID` | The Team ID from step 1 |
| `WDA_BUNDLE_ID` | A bundle id you control, e.g. `com.yourorg.WebDriverAgentRunner` |
| `IOS_PLATFORM_VERSION` | The iOS version on the phone, e.g. `17.5` |
| `DATABASE_URL` | `postgresql://viral_farm:PASSWORD@127.0.0.1:5432/viral_farm` |
| `POSTGRES_PASSWORD` | The same password, used by the bundled database |

<details>
<summary><b>Optional keys</b></summary>

| Key | Default | Purpose |
| --- | --- | --- |
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `3000` | Dashboard bind address |
| `APPIUM_HOST` / `APPIUM_PORT` | `127.0.0.1` / `4725` | Where task subprocesses find Appium |
| `VIRAL_FARM_PLUGINS` | empty | Comma-separated ESM packages with extra plugins |
| `VIRAL_FARM_AUTH_PLUGIN` | unset | ESM `AuthProvider`. Required before `WEB_HOST` leaves loopback |
| `TIKTOK_BUNDLE_ID` | `com.zhiliaoapp.musically` | TikTok app to drive |
| `DEVICES_CONFIG_PATH` | `devices.json` | Registered devices |
| `SCHEDULER_DATA_DIR` | `.scheduler-data` | Uploaded media |
| `WDA_LOCAL_PORT` / `MJPEG_LOCAL_PORT` | `8100` / `9100` | First forwarded ports; each further device takes the next pair |
| `IOS_UDID` | unset | Pins the CLI scripts to one phone. Normally unnecessary |

</details>

No device UDID goes in `.env`. The CLI scripts and the registration wizard find the phone on their own. Passcodes stay out of `.env` too, see [Devices and secrets](#devices-and-secrets).

---

## 5. Database

```sh
npm run db:up        # bundled Postgres in Docker; skip if you run your own
npm run db:migrate   # scheduler schema plus the pg-boss queue
```

---

## 6. Build WebDriverAgent

```sh
npm run wda:prepare                  # the connected, or sole registered, device
npm run wda:prepare -- --udid <udid> # one specific device
npm run wda:prepare -- --all         # every device in devices.json
```

This patches Appium's bundled WebDriverAgent and runs `xcodebuild build-for-testing` signed with your team. It ends with `** TEST BUILD SUCCEEDED **`.

Run it from a graphical login session (Terminal.app or a remote desktop), not a bare SSH shell. Code signing reads the login keychain, which is only unlocked in a graphical session.

<details>
<summary><b>If you must run it over SSH</b></summary>

```sh
security unlock-keychain ~/Library/Keychains/login.keychain-db
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <password> ~/Library/Keychains/login.keychain-db
```

</details>

---

## 7. Run

Four long-lived processes. Four terminals in development; one `launchd` agent or systemd unit each on an always-on host. They take no arguments, only the repo as working directory and `.env` in place.

| Command | Process | Port |
| --- | --- | --- |
| `npm run appium` | Appium 3 with the XCUITest driver | 4725 |
| `npm run wda:service` | One WebDriverAgent per phone, kept alive | 8100+, 9100+ |
| `npm run worker` | Runs due tasks from the queue | — |
| `npm run web` | Dashboard and JSON API | 3000 |

---

## 8. Register and schedule

1. Open <http://127.0.0.1:3000> and choose **Register device** in the sidebar.
2. Pick the connected phone and press **Set up this device**.
3. Give it a name, confirm the coordinate profile, add TikTok handles and an unlock passcode if you want automatic unlocking.
4. Press **Prepare device**, then **Verify device**, and clear any check that asks for a manual step. Unlock the phone when WebDriverAgent first launches.
5. Press **Finish registration**. You land on the device page.

From the device page, **Configure** starts a doomscroll and **Prepare post** uploads media. Both run now, once at a chosen time, or daily or weekly. Progress shows in **Automation log**; every run is also listed under **Tasks**.

---

## Authentication

On a loopback bind, authentication is optional. Before binding anywhere else, set `VIRAL_FARM_AUTH_PLUGIN` to an ESM module whose default export implements `AuthProvider` from [`src/plugin.ts`](../src/plugin.ts). Startup refuses a non-loopback bind without one.

The provider registers its own login routes on the Fastify instance, answers `authenticate(request, reply)` per request, lists unauthenticated paths through `isPublicPath()`, and may set `logoutPath` to get a Log out entry in the sidebar.

---

## Devices and secrets

Registered devices live in `devices.json`. It is git-ignored and written `0600`.

```json
[
  {
    "name": "Phone A",
    "udid": "00008030-000000000000000E",
    "wdaLocalPort": 8100,
    "mjpegLocalPort": 9100,
    "coordinateProfile": "iphone8",
    "passcode": "123456",
    "pluginData": { "com.viral-farm.tiktok": { "accounts": ["@handle"] } }
  }
]
```

| Field | Meaning |
| --- | --- |
| `coordinateProfile` | Which compiled tap layout to use. See [coordinates.md](coordinates.md) |
| `coordinates` | Per-device overrides of single tap targets, set from **Touch points** |
| `passcode` | Unlock code used to wake the phone before automation. Never returned by the API; `GET /api/devices` reports `hasPasscode` instead |
| `pluginData[<pluginId>]` | Per-device plugin settings. Never secrets |
| `disabled` | `true` keeps the entry but stops supervision. Toggle with **Disconnect** on a device card or `PATCH /api/devices/:udid` |

Set or clear a passcode from the device page menu → **Passcode**, or with `PATCH /api/devices/:udid` and `{"passcode": "…"}`. An empty string clears it.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `wda: error … stale or corrupted` | Re-run `npm run wda:prepare`. If it keeps producing an empty app, delete `~/Library/Developer/Xcode/DerivedData/WebDriverAgent-*` |
| `wda: unlock-required` | Unlock the iPhone once by hand |
| `Appium is unavailable on port 4725` | `npm run appium` is not running, or a stale process holds the port |
| `errSecInternalComponent` during `wda:prepare` | You are in an SSH session. Use a graphical session or unlock the keychain as shown above |
| The dashboard answers 401 everywhere | An auth provider is configured. Sign in, or unset `VIRAL_FARM_AUTH_PLUGIN` on loopback |
| `sh: appium: command not found` inside an agent | Call `node node_modules/appium/index.js …` directly |
| Device card says Offline while plugged in | Check `xcrun xctrace list devices`, trust and Developer Mode. Then **Reconnect** on the device page |

`GET /health` on the web port lists loaded plugins and the release marker. The `wda:service` socket at `.wda/wda-service.sock` serves `/health` with per-device state.
