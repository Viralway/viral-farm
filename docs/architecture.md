# Architecture

Four processes, one PostgreSQL database, a few local files. No client framework: the dashboard is server-rendered HTML with HTMX, and live video is MJPEG.

```
                        ┌────────────────────────────────┐
  browser ─── HTTP ────▶│  web   Fastify + HTMX    :3000 │
                        │  dashboard · JSON API · plugins│
                        └──────┬──────────────────┬──────┘
                               │ SQL              │ Unix socket
                               ▼                  ▼
        ┌──────────────────────────┐   ┌──────────────────────────────┐
        │ PostgreSQL               │   │ wda-service                  │
        │  scheduler.*  pgboss.*   │   │  one WebDriverAgent per phone│
        └───────────▲──────────────┘   │  forwards :8100+ and :9100+  │
                    │ pg-boss          └──────────────┬───────────────┘
        ┌───────────┴──────────────┐                  │ USB
        │ worker                   │   ┌──────────────▼───────────────┐
        │  runs due tasks          │──▶│ appium  :4725                │──▶ iPhone
        └──────────────────────────┘   └──────────────────────────────┘
```

---

## Processes

| Process | Entry | Owns |
| --- | --- | --- |
| `web` | `src/api/server.ts` → `src/api/app.ts` | Dashboard, JSON API, registration, plugin routes, remote control |
| `worker` | `src/scheduler/worker.ts` | Turning due schedules into executions and running them |
| `wda-service` | `src/devices/wda-service.ts` | Keeping one WebDriverAgent alive per phone and forwarding its ports |
| `appium` | `appium --port 4725` | XCUITest sessions for task subprocesses |

### web

Fastify on `WEB_PORT`.

- Pages: `/` devices, `/devices/:udid` device, `/tasks` tasks, `/devices/register` wizard. Templates live in `static/dashboard/templates` and share one app shell (sidebar, top bar, content well).
- API under `/api/*`: devices, device registrations, schedules, executions, assets, coordinates and remote control.
- Live screen: `GET /api/devices/:udid/remote/stream` proxies the phone's MJPEG feed and closes the upstream when the browser leaves. The device grid uses `…/remote/screenshot` stills instead. `POST …/remote/action` sends taps and swipes straight to WebDriverAgent, not through Appium.
- Loads plugins from `VIRAL_FARM_PLUGINS` and the auth provider from `VIRAL_FARM_AUTH_PLUGIN`. Plugin nav links join the sidebar; plugin routes mount under `/plugins/<id>` or any path the plugin chooses.
- Refuses to bind outside loopback without an auth provider (`assertSafeBind`).
- A CSRF guard rejects non-GET requests without a same-origin `Origin` header unless they carry a Bearer token or the origin is listed in `VIRAL_FARM_TRUSTED_ORIGINS`.

### worker

Headless.

- One pg-boss worker per active device, queue `ios-device-<hash(udid)>`. Devices with `disabled: true` are skipped.
- Every 5 s, due schedules become `executions` rows and jobs. Every 30 s, newly registered devices get a worker.
- Each job waits for the phone, WebDriverAgent and Appium to be ready, builds a `TaskExecutionContext` and calls the task's `execute()`. Attempts, retry policy, stop requests and the run-window deadline are handled here (`src/scheduler/executor.ts`).
- Must load exactly the same plugin versions as `web`.

### wda-service

- Runs `xcodebuild test-without-building -destination id=<udid>` per active device, which installs the pre-signed WebDriverAgent runner and starts it as a UI test.
- USB-forwards the device's `:8100` (WebDriverAgent) and `:9100` (MJPEG) to the host's next free pair.
- Controlled over `.wda/wda-service.sock`. `GET /health` reports `{ physical, wda, appium, message }` per device. A lock prevents a second supervisor.

### appium

Appium 3 with the pinned XCUITest driver, isolated in `.appium2`. Task subprocesses such as the TikTok doomscroll connect with `webdriverio`. Loopback only.

---

## Xcode, signing and pairing

The farm never pairs or signs by itself. It drives Xcode's toolchain.

| Step | Who does it | How |
| --- | --- | --- |
| Pair and trust | You, once | USB, Trust This Computer, Developer Mode |
| Discover | `appium-ios-device` over usbmuxd | `discoverConnectedDevices()` learns a phone is attached |
| Developer Disk Image | Xcode | Mounted on first pairing; `xcodebuild` needs it to launch a test bundle |
| Sign | `npm run wda:prepare` | `xcodebuild build-for-testing` with automatic signing and `DEVELOPMENT_TEAM=$XCODE_ORG_ID`. The provisioning profile lists connected UDIDs, so the phone must be plugged in |
| Launch | `wda-service` | `xcodebuild test-without-building` per device |

The registration wizard (`src/devices/registration.ts`) probes each link of that chain (`host`, `connection`, `signing`, `developer`, `wda`, `appium`, `video`, `touch`) and shows a specific fix before the device is written to `devices.json`. `wda:prepare` is the same signing step without the UI.

---

## Data and state

| Store | Contents |
| --- | --- |
| PostgreSQL `scheduler.*` | `schedules`, `executions`, `execution_attempts`, `execution_logs`, `assets`. Drizzle ORM, migrations in `drizzle/` |
| PostgreSQL `pgboss.*` | Job queue, one per device |
| `devices.json` | Registered devices with ports, profile, overrides, passcode, `disabled`, `pluginData`. Git-ignored, `0600` |
| `.env` | Configuration. Git-ignored |
| `.scheduler-data/uploads/` | Uploaded media, one file per asset id |
| `.wda/` | Supervisor socket and locks |
| `.appium2/` | Isolated Appium home |

---

## Task model

Every schedule and execution carries a task envelope:

```
pluginId    "com.viral-farm.tiktok"
taskType    "doomscroll"
taskVersion 1
payload     validated JSON for that exact version
```

`PluginRegistry.task(envelope)` resolves it to a `TaskDefinition`. Because the version is stored, an old schedule never runs new logic: if version 1 is no longer installed, that schedule fails loudly instead of executing version 2.

---

## Scheduling

`ScheduleTiming` in `src/types.ts`:

| kind | fields |
| --- | --- |
| `now` | — |
| `once` | `runAt` (ISO 8601) |
| `daily` | `localTime` `"HH:MM"`, `timezone` (IANA) |
| `weekly` | `localTime`, `timezone`, `weekdays` (0 = Sunday … 6) |

`runWindowMinutes` (default 30) is the grace period after the scheduled time. Past it, the execution is abandoned as expired. Recurrence lives in `src/scheduler/recurrence.ts` and writes the next occurrence to `schedules.next_run_at`.

---

## Source map

| Path | Responsibility |
| --- | --- |
| `src/api/` | Fastify app factory, routes, fragments, shell rendering |
| `src/scheduler/` | Runtime, repository, pg-boss queue, recurrence, worker, executor |
| `src/database/` | Drizzle client, schema, migrate and setup entrypoints |
| `src/devices/` | Discovery, `devices.json` registry, registration wizard, WebDriverAgent remote and supervisor, coordinate profiles |
| `src/devices/wda/` | `prepare.ts` patches, builds and signs WebDriverAgent; `start.ts` single-device supervisor; `target-device.ts` resolves the CLI target |
| `src/tiktok/` | TikTok automation entrypoints (`doomscroll.ts`, `post.ts`), OCR, coordinates |
| `src/tiktok-plugin.ts` | The built-in plugin |
| `src/plugin.ts` | Stable plugin and auth interfaces |
| `src/registry.ts` | `PluginRegistry`: task resolution and validation |
| `src/loader.ts` | Dynamic import of plugins and the auth provider |
| `src/example-plugin.ts` | Minimal reference plugin |
| `static/dashboard/` | Templates, `styles.css`, browser TypeScript in `ts/` compiled to `assets/` |
| `Patches/` | WebDriverAgent patches applied by `wda:prepare` |
| `drizzle/` | SQL migrations and journal |
