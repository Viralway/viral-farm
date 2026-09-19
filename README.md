<div align="center">
   <h2>Viral Farm</h2>
</div>

<p align="center">
  <img src="static/dashboard/assets/img/viral.png" alt="Viral Farm Logo" width="170"/>
</p>

<div align="center">
   <p><b>A self hosted phone farm for account warming, doomscrolling scheduling, and TikTok automation</b></p>
</div>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#run">Run</a> ·
  <a href="#dashboard">Dashboard</a> ·
  <a href="#configure">Configure</a> ·
  <a href="#plugins">Plugins</a> ·
  <a href="#docs">Docs</a>
</p>

<p align="center">
  <img src="static/dashboard/assets/img/demo_img.png" alt="Viral Farm dashboard" width="800"/>
</p>

https://github.com/user-attachments/assets/d16fab01-2051-4058-9f0f-a8009e42de14

---

## What it is

A self-hosted control plane for real iPhones. Plug phones into a Mac, register them from the browser, watch their screens live, and schedule TikTok automation that runs on a durable PostgreSQL queue.

| Module | What it does |
| --- | --- |
| **Devices** | Guided registration, live MJPEG screen, remote tap and swipe, per-device passcode and touch-point calibration |
| **Scheduler** | One-off and recurring tasks, execution history, logs, retries, uploads |
| **TikTok plugin** | Built in: `doomscroll` (timed, personality-driven scrolling) and `post` (video or slideshow, draft or publish) |
| **Plugin API** | Add your own versioned tasks, dashboard panels, routes and registration checks |
| **Dashboard** | Server-rendered HTML with HTMX, light and dark |

---

## Quick start

<details>
<summary><b>Requirements</b></summary>

- macOS with the full Xcode installed and selected (`xcode-select -p` points at `Xcode.app`)
- Node.js 22 or newer
- PostgreSQL 14 or newer (a `docker compose` service is included)
- An Apple Developer team, used to sign WebDriverAgent
- A physical iPhone, trusted and in Developer Mode, connected by USB

</details>

```sh
npm install
cp .env.example .env              # fill in XCODE_ORG_ID, WDA_BUNDLE_ID, IOS_PLATFORM_VERSION, POSTGRES_PASSWORD
npm run appium:install-driver     # XCUITest driver into ./.appium2
npm run db:up && npm run db:migrate
npm run wda:prepare               # builds and signs WebDriverAgent for the connected phone
```

Run `wda:prepare` from a graphical session, not a bare SSH shell. Code signing needs the login keychain unlocked.

---

## Run

Four long-lived processes. Four terminals in development, one `launchd` agent or systemd unit each on an always-on host.

| Command | Process | Port |
| --- | --- | --- |
| `npm run appium` | Appium with the XCUITest driver | 4725 |
| `npm run wda:service` | One WebDriverAgent per phone, kept alive | 8100+, 9100+ |
| `npm run worker` | Runs due tasks from the queue | — |
| `npm run web` | Dashboard and JSON API | 3000 |

Then open <http://127.0.0.1:3000>, go to **Register device**, and step through the checks.

---

## Dashboard

| Page | Route | You can |
| --- | --- | --- |
| Devices | `/` | See every phone with a live still, open one, disconnect or reconnect it |
| Device | `/devices/:udid` | Watch the screen, tap and swipe, run or schedule doomscroll and post, manage accounts, passcode and touch points |
| Tasks | `/tasks` | Pause, resume, edit or cancel schedules; stop or retry executions |
| Register device | `/devices/register` | Guided setup with rechecked requirements |

The same data is available as JSON under `/api/*` (devices, registrations, schedules, executions, assets, remote control). `GET /health` lists loaded plugins.

---

## Configure

Everything lives in `.env`. The keys you must set:

| Key | Value |
| --- | --- |
| `XCODE_ORG_ID` | Your Apple Development Team ID (Xcode → Settings → Accounts) |
| `WDA_BUNDLE_ID` | A bundle id you control, e.g. `com.yourorg.WebDriverAgentRunner` |
| `IOS_PLATFORM_VERSION` | The iOS version on the phone, e.g. `17.5` |
| `DATABASE_URL` | `postgresql://viral_farm:PASSWORD@127.0.0.1:5432/viral_farm` |
| `POSTGRES_PASSWORD` | Used by the bundled `docker compose` database |

<details>
<summary><b>Optional keys</b></summary>

| Key | Default | Purpose |
| --- | --- | --- |
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `3000` | Where the dashboard binds |
| `VIRAL_FARM_PLUGINS` | empty | Comma-separated ESM packages with extra task plugins |
| `VIRAL_FARM_AUTH_PLUGIN` | unset | ESM `AuthProvider`. Required before `WEB_HOST` leaves loopback; startup refuses otherwise |
| `TIKTOK_BUNDLE_ID` | `com.zhiliaoapp.musically` | TikTok app to drive |
| `DEVICES_CONFIG_PATH` | `devices.json` | Registered devices and their per-device plugin data |
| `SCHEDULER_DATA_DIR` | `.scheduler-data` | Uploaded media |
| `IOS_UDID` | unset | Pin the CLI scripts to one phone |

</details>

<details>
<summary><b>Devices and secrets</b></summary>

Registered phones are stored in `devices.json`, which is git-ignored and written `0600`. Unlock passcodes live there, never in `.env`, and are never returned by the API. Per-device plugin settings sit under `pluginData[<pluginId>]`. Set `disabled: true` (or press **Disconnect** on a card) to keep a phone registered without supervising it.

</details>

---

## Plugins

A plugin is an ESM package exporting versioned tasks and, optionally, device panels, nav links, routes, registration checks and WebDriverAgent extensions. Tasks are persisted as `pluginId`, `taskType`, `taskVersion` and a JSON payload, so an old schedule can never run a new contract by accident.

- Interfaces: [`src/plugin.ts`](src/plugin.ts)
- Reference plugin: [`src/example-plugin.ts`](src/example-plugin.ts)
- Built-in TikTok plugin: [`src/tiktok-plugin.ts`](src/tiktok-plugin.ts)

Plugins are trusted code with the same access as the service itself. Install only reviewed, pinned packages.

---

## Docs

| Read | For |
| --- | --- |
| [docs/getting-started.md](docs/getting-started.md) | Xcode pairing, install, configure, first device, troubleshooting |
| [docs/architecture.md](docs/architecture.md) | The four processes, data stores, task model, source map |
| [docs/coordinates.md](docs/coordinates.md) | Tap-layout profiles and per-device calibration |

---

## Development

```sh
npm run check      # typecheck + tests
npm run build:web  # compile the dashboard scripts in static/dashboard/ts
```

The server runs TypeScript directly through `tsx`; only the browser scripts are compiled. CI is GitHub-hosted only: never attach real devices, signing material, production databases or deployment credentials to workflows triggered by pull requests.

---

## License

Apache 2.0. See [LICENSE](LICENSE).
