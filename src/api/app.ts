import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';

import { discoverConnectedDevices } from '../devices/discovery.js';
import { loadRegisteredDevices, mutateRegisteredDevices, saveRegisteredDevices, redactDevice, PASSCODE_PATTERN, type RegisteredDevice } from '../devices/registry.js';
import {
    CALIBRATABLE_POINTS, POINT_LABELS, coordinatesForProfile, resolveDeviceCoordinates, validateCoordinateOverrides,
} from '../devices/coordinates.js';
import { RegistryWdaRemoteControl } from '../devices/registry-remote.js';
import type {
    DeviceRegistrationManager, RegistrationAction, RegistrationUpdate,
} from '../devices/registration.js';
import { type RemoteAction } from '../devices/wda-remote.js';
import { requestWdaService } from '../devices/wda-service-client.js';
import type { DeviceConnectionStatus } from '../devices/connection-manager.js';
import type { AuthProvider, PluginNavLink } from '../plugin.js';
import type { PluginRegistry } from '../registry.js';
import type { CreateTaskInput, JsonObject, ScheduleTiming } from '../types.js';
import { ScheduleTransitionError, type SchedulerRepository } from '../scheduler/repository.js';

export interface CreateAppOptions {
    plugins: PluginRegistry;
    scheduler: SchedulerRepository;
    authProvider?: AuthProvider | null;
    dashboardTheme?: DashboardTheme;
    registrations?: DeviceRegistrationManager;
    logger?: boolean;
}

export interface DashboardTheme {
    rootDirectory: string;
    renderDevice?(template: string, device: RegisteredDevice): string;
}

interface LoadedDashboardTheme {
    indexHtml: string;
    deviceHtml: string;
    tasksHtml: string;
    styles: string;
    deviceScript: string;
    tasksScript: string;
    registerDeviceHtml: string;
    registerDeviceScript: string;
    shellScript: string;
    htmx: string;
}

// Lucide-style 24-viewBox strokes: the structural chrome set the design system
// allows outside FontAwesome (section 6).
const ICONS = {
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    calendar: '<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
} as const;

function svgIcon(name: keyof typeof ICONS, className = 'icon'): string {
    return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

// Viralway lockup and badge (design system section 7). The PNG is a 512×512
// canvas; this window is the inked area so the slot shows the mark, not padding.
const LOGO_MARK_VIEW_BOX = '178 44 172 406';
const LOGO_HTML = `<svg class="logo" viewBox="0 0 134 40" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" fill="none" role="img" aria-label="Viralway Logo">`
    + `<svg x="0" y="0" width="20" height="40" viewBox="${LOGO_MARK_VIEW_BOX}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
    + '<image class="mark-black" href="/assets/img/viralway.png" x="0" y="0" width="512" height="512"/>'
    + '<image class="mark-white" href="/assets/img/viralway-white.png" x="0" y="0" width="512" height="512"/></svg>'
    + '<text x="28" y="29.5" font-size="27" font-weight="700" letter-spacing="-0.6">Viralway</text></svg>';
const LOGO_BADGE_HTML = `<svg class="logo-badge" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" preserveAspectRatio="xMidYMid meet" fill="none" role="img" aria-label="Viralway">`
    + '<rect width="40" height="40" rx="8" fill="#fff"/>'
    + `<svg x="5" y="5" width="30" height="30" viewBox="${LOGO_MARK_VIEW_BOX}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
    + '<image href="/assets/img/viralway.png" x="0" y="0" width="512" height="512"/></svg></svg>';
const THEME_TOGGLE_HTML = '<button class="icon-circle" type="button" data-theme-toggle data-tooltip="Toggle Dark Mode" aria-label="Toggle Dark Mode">'
    + `${svgIcon('moon', 'icon-sm theme-icon-moon')}${svgIcon('sun', 'icon-sm theme-icon-sun')}</button>`;

interface NavEntry { key: string; href: string; label: string; icon: keyof typeof ICONS }

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Thrown inside route bodies / registry mutations; mapped to its status by setErrorHandler. */
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
    return Object.assign(new Error(message), { statusCode });
}

function csrfBlocked(reply: FastifyReply): FastifyReply {
    return reply.code(403).send({
        error: 'Cross-origin write blocked. Send an Authorization: Bearer token for API clients, '
            + 'or add the origin to VIRAL_FARM_TRUSTED_ORIGINS.',
    });
}

function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
}

// Shown at the foot of every dashboard page. Override the link with
// VIRAL_FARM_BRAND_URL; the text is fixed.
const FOOTER_HTML = `Built by <a href="${escapeHtml(process.env.VIRAL_FARM_BRAND_URL ?? 'https://agniverse.co')}" target="_blank" rel="noopener">Agniverse</a>, with love and curry &#10084;&#65039;`;

function page(title: string, body: string, logoutPath?: string, navLinks: readonly PluginNavLink[] = []): string {
    const logout = logoutPath ? `<a href="${escapeHtml(logoutPath)}" style="float:right;margin-right:0">Log out</a>` : '';
    const extra = navLinks.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:15px system-ui,sans-serif;margin:0;background:#f6f7f9;color:#17202a}nav{padding:16px 24px;background:#111827;color:white}nav a{color:white;margin-right:18px}main{max-width:1100px;margin:24px auto;padding:0 20px}.card{background:white;border:1px solid #dde2e8;border-radius:10px;padding:18px;margin:14px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #e5e7eb}code{font-size:12px}.muted{color:#64748b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}button,.button{background:#2563eb;color:white;border:0;border-radius:6px;padding:8px 12px;text-decoration:none;cursor:pointer}input,select,textarea{padding:8px;border:1px solid #cbd5e1;border-radius:6px}</style></head>
<body><nav><a href="/">Devices</a><a href="/tasks">Tasks</a><a href="/docs">API</a>${extra}${logout}</nav><main>${body}</main><footer style="max-width:1100px;margin:24px auto;padding:16px 20px;color:#94a3b8;font-size:12px">${FOOTER_HTML}</footer></body></html>`;
}

async function registeredWithStatus() {
    const [registered, connected] = await Promise.all([loadRegisteredDevices(), discoverConnectedDevices()]);
    const online = new Map(connected.map((device) => [device.udid, device]));
    return registered.map((device) => ({
        ...redactDevice(device),
        connected: device.disabled ? null : online.get(device.udid) ?? null,
    }));
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
    const app = Fastify({ logger: options.logger ?? false, bodyLimit: 50 * 1024 * 1024 });
    await app.register(formbody);
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 20 } });

    // Server-rendered HTML must never be cached — a stale page + fresh assets
    // (or vice versa) breaks the dashboard after a deploy.
    app.addHook('onSend', async (_request, reply) => {
        const type = reply.getHeader('content-type');
        if (typeof type === 'string' && type.includes('text/html') && !reply.hasHeader('cache-control')) {
            reply.header('cache-control', 'no-cache');
        }
    });

    // CSRF guard — runs for every deployment, auth or not. The default loopback
    // dashboard is otherwise open to form-encoded POSTs from any page the
    // operator has open in the same browser (tap the phone, stop executions,
    // launch tasks). A Bearer token means a real API client, not a browser form.
    app.addHook('onRequest', async (request, reply) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
        if (request.headers.authorization?.startsWith('Bearer ')) return;
        const origin = request.headers.origin;
        if (!origin) return csrfBlocked(reply);
        const configured = [process.env.PUBLIC_ORIGIN, ...(process.env.VIRAL_FARM_TRUSTED_ORIGINS ?? '').split(',')]
            .map((value) => value?.trim().replace(/\/+$/, '')).filter((value): value is string => Boolean(value));
        if (configured.length) {
            if (!configured.includes(origin.replace(/\/+$/, ''))) return csrfBlocked(reply);
            return;
        }
        // Nothing configured: same-origin only, compared by host (ignoring
        // scheme) so a TLS-terminating proxy that doesn't forward
        // x-forwarded-proto still passes. URL normalises default ports, so
        // compare the Origin's host against the request Host under both schemes.
        // Set VIRAL_FARM_TRUSTED_ORIGINS if the proxy also rewrites Host.
        let originHost: string;
        try { originHost = new URL(origin).host; } catch { return csrfBlocked(reply); }
        const hostMatches = ['http', 'https'].some((scheme) => {
            try { return new URL(`${scheme}://${request.headers.host}`).host === originHost; } catch { return false; }
        });
        if (!hostMatches) return csrfBlocked(reply);
    });

    if (options.authProvider) {
        await options.authProvider.registerRoutes(app);
        app.addHook('onRequest', async (request, reply) => {
            if (options.authProvider?.isPublicPath(request.url.split('?')[0] ?? request.url)) return;
            const user = await options.authProvider?.authenticate(request, reply);
            if (!user && !reply.sent) await reply.code(401).send({ error: 'Authentication required' });
        });
    }

    const remote = new RegistryWdaRemoteControl();
    const logoutPath = options.authProvider?.logoutPath;
    const authNavHtml = logoutPath
        ? `<a class="button secondary app-logout" href="${escapeHtml(logoutPath)}">Log out</a>` : '';
    const navLinks: PluginNavLink[] = options.plugins.list()
        .flatMap((plugin) => plugin.navLinks ?? [])
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const pluginNavHtml = navLinks
        .map((link) => `<a class="button secondary" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
        .join('');
    const renderPage = (title: string, body: string) => page(title, body, logoutPath, navLinks);
    const assetHash = (body: string) => crypto.createHash('sha1').update(body).digest('base64url').slice(0, 10);

    // App-shell navigation (design system 8.1): sidebar items on lg+, the same
    // entries as a bottom tab bar below lg, log out pinned to the end.
    const navEntries: NavEntry[] = [
        { key: 'devices', href: '/', label: 'Devices', icon: 'smartphone' },
        { key: 'register', href: '/devices/register', label: 'Register device', icon: 'plus' },
        { key: 'tasks', href: '/tasks', label: 'Tasks', icon: 'calendar' },
        ...navLinks.map((link, index): NavEntry => ({ key: `plugin-${index}`, href: link.href, label: link.label, icon: 'link' })),
    ];
    const navItem = (entry: NavEntry, current: string, extraClass = '') =>
        `<a class="nav-item${extraClass}" href="${escapeHtml(entry.href)}"${entry.key === current ? ' aria-current="page"' : ''}>${svgIcon(entry.icon)}<span>${escapeHtml(entry.label)}</span></a>`;
    const sidebarNav = (current: string) => `<nav class="sidebar-nav" aria-label="Navigation">${navEntries.map((entry) => navItem(entry, current)).join('')}`
        + (logoutPath ? navItem({ key: 'logout', href: logoutPath, label: 'Log out', icon: 'logout' }, current, ' nav-group-end') : '') + '</nav>';
    const tabNav = (current: string) => navEntries.map((entry) =>
        `<a class="tab-item" href="${escapeHtml(entry.href)}" aria-label="${escapeHtml(entry.label)}"${entry.key === current ? ' aria-current="page"' : ''}>${svgIcon(entry.icon)}</a>`).join('');
    const authIconHtml = logoutPath
        ? `<a class="icon-circle" href="${escapeHtml(logoutPath)}" data-tooltip="Log out" aria-label="Log out">${svgIcon('logout', 'icon-sm')}</a>` : '';

    let themed: LoadedDashboardTheme | null = null;
    const themeRoot = options.dashboardTheme?.rootDirectory;
    if (themeRoot) {
        const root = themeRoot;
        const require = createRequire(import.meta.url);
        const [indexHtml, deviceHtml, tasksHtml, registerDeviceHtml, styles, deviceScript, tasksScript, registerDeviceScript, shellScript, htmx] = await Promise.all([
            readFile(path.join(root, 'templates/index.html'), 'utf8'),
            readFile(path.join(root, 'templates/device.html'), 'utf8'),
            readFile(path.join(root, 'templates/tasks.html'), 'utf8'),
            readFile(path.join(root, 'templates/register-device.html'), 'utf8'),
            readFile(path.join(root, 'styles.css'), 'utf8'),
            readFile(path.join(root, 'assets/device.js'), 'utf8'),
            readFile(path.join(root, 'assets/tasks.js'), 'utf8'),
            readFile(path.join(root, 'assets/register-device.js'), 'utf8'),
            readFile(path.join(root, 'assets/shell.js'), 'utf8'),
            readFile(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8'),
        ]);
        // Content-hash every asset URL in the templates so a changed file gets a
        // fresh URL that no browser or CDN can serve stale.
        const versions: Record<string, string> = {
            'styles.css': assetHash(styles), 'device.js': assetHash(deviceScript),
            'tasks.js': assetHash(tasksScript), 'register-device.js': assetHash(registerDeviceScript),
            'shell.js': assetHash(shellScript), 'htmx.min.js': assetHash(htmx),
        };
        const finalize = (html: string, current: string) => {
            let out = html.replaceAll('__AUTH_NAV__', authNavHtml).replaceAll('__PLUGIN_NAV__', pluginNavHtml)
                .replaceAll('__SIDEBAR_NAV__', sidebarNav(current)).replaceAll('__TAB_NAV__', tabNav(current))
                .replaceAll('__AUTH_ICON__', authIconHtml).replaceAll('__THEME_TOGGLE__', THEME_TOGGLE_HTML)
                .replaceAll('__LOGO_BADGE__', LOGO_BADGE_HTML).replaceAll('__LOGO__', LOGO_HTML)
                .replaceAll('__ICON_X__', svgIcon('x'))
                .replaceAll('__FOOTER__', FOOTER_HTML);
            for (const [name, v] of Object.entries(versions)) out = out.replaceAll(`/assets/${name}`, `/assets/${name}?v=${v}`);
            return out;
        };
        themed = {
            indexHtml: finalize(indexHtml, 'devices'), deviceHtml: finalize(deviceHtml, 'devices'),
            tasksHtml: finalize(tasksHtml, 'tasks'), registerDeviceHtml: finalize(registerDeviceHtml, 'register'),
            styles, deviceScript, tasksScript, registerDeviceScript, shellScript, htmx,
        };
    }

    const renderActivity = async (deviceUdid: string, message?: string): Promise<string> => {
        const executions = await options.scheduler.listExecutions(25, deviceUdid);
        const execution = executions.find(({ status }) => status === 'running') ?? executions[0];
        if (!execution) return `<section id="device-activity" class="run-panel"><div class="run-heading"><span class="status idle"><span class="dot"></span>idle</span><span class="run-meta">No automation has run on this device yet.</span></div>${message ? `<p class="run-error">${escapeHtml(message)}</p>` : ''}<pre>Waiting for output…</pre></section>`;
        const detail = await options.scheduler.execution(execution.id);
        // A plugin (or task version) can be uninstalled while old executions
        // still reference it — degrade instead of throwing out of the fragment.
        let definition: { summarize(payload: JsonObject): string; supportsStop(payload: JsonObject): boolean } | undefined;
        try {
            definition = options.plugins.task({
                pluginId: execution.pluginId, taskType: execution.taskType,
                taskVersion: execution.taskVersion, payload: execution.payload,
            });
        } catch { /* plugin unavailable */ }
        const summary = definition
            ? definition.summarize(execution.payload)
            : `${execution.pluginId}/${execution.taskType}@${execution.taskVersion} (plugin not installed)`;
        const canStop = execution.status === 'queued' || (execution.status === 'running' && (definition?.supportsStop(execution.payload) ?? true));
        const stop = canStop
            ? `<form hx-post="/api/executions/${execution.id}/stop" hx-target="#device-activity" hx-swap="outerHTML"><button class="button secondary xs" type="submit">Stop</button></form>` : '';
        return `<section id="device-activity" class="run-panel" hx-get="/api/devices/${encodeURIComponent(deviceUdid)}/fragments/activity" hx-trigger="every 1s" hx-swap="outerHTML"><div class="run-heading"><span class="status ${escapeHtml(execution.status)}"><span class="dot"></span>${escapeHtml(execution.status)}</span><span class="run-meta">${escapeHtml(summary)} · ${escapeHtml(execution.scheduledFor.toISOString())}</span>${stop}</div>${message ? `<p class="run-error">${escapeHtml(message)}</p>` : ''}<pre>${detail?.logs.length ? detail.logs.map(escapeHtml).join('\n') : escapeHtml(execution.error ?? 'Waiting for worker output…')}</pre></section>`;
    };

    app.get('/health', async () => {
        const body: Record<string, unknown> = {
            ok: true,
            plugins: options.plugins.list().map(({ id, version }) => ({ id, version })),
        };
        // Deploy tooling writes a RELEASED file (sha, subject, deployedAt) into the
        // working directory; surface it so "what's live" is answerable over HTTP.
        try {
            body.release = JSON.parse(await readFile(path.resolve(process.env.VIRAL_FARM_RELEASE_FILE ?? 'RELEASED'), 'utf8'));
        } catch { /* no release marker — fine */ }
        return body;
    });
    app.get('/api/plugins', async () => options.plugins.list().map((plugin) => ({
        id: plugin.id, version: plugin.version, displayName: plugin.displayName,
        tasks: plugin.tasks.map(({ type, version, displayName }) => ({ type, version, displayName })),
    })));
    app.get('/api/devices', async () => registeredWithStatus());
    app.get('/api/devices/discovered', async () => discoverConnectedDevices());
    app.get('/api/device-registrations/candidates', async (_request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return { devices: await options.registrations.candidates() };
    });
    app.post<{ Body: { udid?: string } }>('/api/device-registrations', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        if (!request.body.udid?.trim()) return reply.code(400).send({ error: 'Device UDID is required' });
        return reply.code(201).send(await options.registrations.create(request.body.udid.trim()));
    });
    app.get<{ Params: { id: string } }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return await options.registrations.get(request.params.id)
            ?? reply.code(404).send({ error: 'Registration draft not found' });
    });
    app.patch<{ Params: { id: string }; Body: RegistrationUpdate }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return options.registrations.update(request.params.id, request.body);
    });
    app.post<{ Params: { id: string; action: RegistrationAction }; Body: { authorizeTeamRegistration?: boolean } }>(
        '/api/device-registrations/:id/actions/:action', async (request, reply) => {
            if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
            if (!['refresh', 'prepare', 'verify', 'finalize'].includes(request.params.action)) {
                return reply.code(404).send({ error: 'Unknown registration action' });
            }
            return options.registrations.run(request.params.id, request.params.action, {
                authorizeTeamRegistration: request.body?.authorizeTeamRegistration === true,
            });
        },
    );
    app.delete<{ Params: { id: string } }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        await options.registrations.cancel(request.params.id);
        return reply.code(204).send();
    });
    app.post<{ Body: { name?: string; udid?: string; wdaLocalPort?: number; mjpegLocalPort?: number; passcode?: string; coordinateProfile?: string; pluginData?: Record<string, JsonObject> } }>(
        '/api/devices', async (request, reply) => {
            const { name, udid, wdaLocalPort, mjpegLocalPort, passcode, coordinateProfile, pluginData } = request.body;
            if (!udid) return reply.code(400).send({ error: 'A device UDID is required' });
            if (passcode !== undefined && !PASSCODE_PATTERN.test(passcode)) {
                return reply.code(400).send({ error: 'Device passcode must contain at least four digits' });
            }
            const created = await mutateRegisteredDevices((devices) => {
                if (devices.some((device) => device.udid === udid)) throw httpError(409, 'A device with this UDID is already registered');
                // Explicit whitelist — never mass-assign arbitrary body keys into devices.json.
                const device: RegisteredDevice = {
                    name: name ?? udid, udid, pluginData: pluginData ?? {},
                    ...(wdaLocalPort !== undefined ? { wdaLocalPort } : {}),
                    ...(mjpegLocalPort !== undefined ? { mjpegLocalPort } : {}),
                    ...(coordinateProfile !== undefined ? { coordinateProfile: coordinateProfile as RegisteredDevice['coordinateProfile'] } : {}),
                    ...(passcode !== undefined ? { passcode } : {}),
                };
                devices.push(device);
                return device;
            });
            return reply.code(201).send(redactDevice(created));
        },
    );
    app.patch<{ Params: { udid: string }; Body: { name?: string; wdaLocalPort?: number; mjpegLocalPort?: number; passcode?: string; coordinates?: unknown; disabled?: boolean; coordinateProfile?: string; pluginData?: Record<string, JsonObject> } }>(
        '/api/devices/:udid', async (request, reply) => {
            const { passcode, coordinates, name, wdaLocalPort, mjpegLocalPort, disabled, coordinateProfile, pluginData } = request.body;
            if (passcode !== undefined && passcode !== '' && !PASSCODE_PATTERN.test(passcode)) {
                return reply.code(400).send({ error: 'Device passcode must contain at least four digits' });
            }
            if (disabled === true && await options.scheduler.activeExecution(request.params.udid)) {
                return reply.code(409).send({ error: 'Stop the running automation before disconnecting this device' });
            }
            const updated = await mutateRegisteredDevices((devices) => {
                const device = devices.find((entry) => entry.udid === request.params.udid);
                if (!device) throw httpError(404, 'Device not found');
                if (name !== undefined) device.name = name;
                if (wdaLocalPort !== undefined) device.wdaLocalPort = wdaLocalPort;
                if (mjpegLocalPort !== undefined) device.mjpegLocalPort = mjpegLocalPort;
                if (coordinateProfile !== undefined) device.coordinateProfile = coordinateProfile as RegisteredDevice['coordinateProfile'];
                if (pluginData !== undefined) device.pluginData = pluginData;
                if (disabled === true) device.disabled = true;
                else if (disabled === false) delete device.disabled;
                // passcode: a value sets it, '' clears it, omitting it leaves it
                if (passcode === '') delete device.passcode;
                else if (passcode !== undefined) device.passcode = passcode;
                // coordinates: the object replaces the whole override map; {} clears it
                if (coordinates !== undefined) {
                    const overrides = validateCoordinateOverrides(coordinates, device.coordinateProfile);
                    if (Object.keys(overrides).length === 0) delete device.coordinates;
                    else device.coordinates = overrides;
                }
                return device;
            });
            remote.forget(request.params.udid);
            return redactDevice(updated);
        },
    );
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/coordinates', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        const base = coordinatesForProfile(device.coordinateProfile).tiktok;
        const effective = resolveDeviceCoordinates(device.coordinateProfile, device.coordinates).tiktok;
        return {
            profile: device.coordinateProfile ?? 'iphone8',
            screenSize: coordinatesForProfile(device.coordinateProfile).screenSize,
            points: CALIBRATABLE_POINTS.map((name) => ({
                name, label: POINT_LABELS[name],
                default: base[name], current: effective[name],
                overridden: Boolean(device.coordinates?.[name]),
            })),
        };
    });
    app.delete<{ Params: { udid: string } }>('/api/devices/:udid', async (request, reply) => {
        const exists = (await loadRegisteredDevices()).some(({ udid }) => udid === request.params.udid);
        if (!exists) return reply.code(404).send({ error: 'Device not found' });
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Stop the running automation before removing this device' });
        }
        for (const schedule of await options.scheduler.listSchedules(500, request.params.udid)) {
            if (!['cancelled', 'completed'].includes(schedule.status)) {
                await options.scheduler.setScheduleStatus(schedule.id, 'cancelled');
            }
        }
        await mutateRegisteredDevices((devices) => {
            const index = devices.findIndex(({ udid }) => udid === request.params.udid);
            if (index >= 0) devices.splice(index, 1);
        });
        remote.forget(request.params.udid);
        return reply.code(204).send();
    });
    app.post<{ Params: { udid: string } }>('/api/devices/:udid/checks', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        const identity = (await discoverConnectedDevices()).find(({ udid }) => udid === device.udid) ?? device;
        const results = [];
        for (const plugin of options.plugins.list()) {
            for (const check of plugin.registrationChecks ?? []) {
                results.push({ pluginId: plugin.id, checkId: check.id, ...(await check.run(identity, device.pluginData[plugin.id] ?? {})) });
            }
        }
        return results;
    });

    // NB: /remote/screenshot and /remote/action below are the canonical
    // endpoints — they carry the activeExecution guard and the cached
    // per-device client. The old unprefixed /screenshot and /actions twins
    // that bypassed both were removed.
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/info', async (request, reply) => {
        const device = (await discoverConnectedDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device is not connected' });
        return { device, screen: await remote.getScreenInfo(device.udid) };
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/screenshot', async (request, reply) => {
        try {
            return reply.header('cache-control', 'no-store').type('image/png').send(await remote.getScreenshot(request.params.udid));
        } catch {
            // A flapping device shouldn't spew 500s into the log every 5s from the grid poll.
            return reply.code(503).header('cache-control', 'no-store').send();
        }
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/stream', async (request, reply) => {
        // Close the upstream device stream the moment the browser goes away —
        // otherwise every HTMX fragment swap leaks a live MJPEG connection.
        const abort = new AbortController();
        request.raw.once('close', () => abort.abort());
        const upstream = await remote.getMjpegStream(request.params.udid, abort.signal);
        if (!upstream.body) return reply.code(503).send({ error: 'Device stream is unavailable' });
        return reply.header('cache-control', 'no-store, no-cache, must-revalidate')
            .type(upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=--BoundaryString')
            .send(Readable.from(upstream.body as AsyncIterable<Uint8Array>));
    });
    app.post<{ Params: { udid: string }; Body: RemoteAction }>('/api/devices/:udid/remote/action', async (request, reply) => {
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Remote input is disabled while automation is running' });
        }
        await remote.performAction(request.params.udid, request.body);
        return { ok: true };
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/connection', async (request, reply) => {
        const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!registered) return reply.code(404).send({ error: 'Device is not registered' });
        // Prefer the real per-device state the wda-service supervisor tracks
        // (physical, wda, appium, retryCount, message).
        try {
            const response = await requestWdaService('/devices', { timeoutMs: 2_000 });
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const status = (JSON.parse(response.body).devices as DeviceConnectionStatus[])
                    .find((entry) => entry.udid === registered.udid);
                if (status) return status;
            }
        } catch { /* supervisor socket unavailable — fall back to a probe */ }
        const connected = (await discoverConnectedDevices()).some(({ udid }) => udid === registered.udid);
        let wda = false;
        try {
            wda = (await fetch(`http://127.0.0.1:${registered.wdaLocalPort ?? 8100}/status`, { signal: AbortSignal.timeout(2_000) })).ok;
        } catch { /* WDA not up */ }
        const fallback: DeviceConnectionStatus = {
            udid: registered.udid, physical: connected ? 'connected' : 'disconnected',
            wda: wda ? 'ready' : connected ? 'connecting' : 'disconnected', appium: 'unavailable',
            managed: false, message: wda ? 'WDA is ready' : connected ? 'Waiting for WDA' : 'Reconnect the USB cable',
            retryCount: 0, updatedAt: new Date().toISOString(),
        };
        return fallback;
    });
    app.post<{ Params: { udid: string } }>('/api/devices/:udid/reconnect', async (request, reply) => {
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Cannot reconnect while automation is running' });
        }
        remote.forget(request.params.udid);
        return reply.code(202).send({ ok: true, message: 'The shared WDA supervisor will reconnect automatically' });
    });

    app.get<{ Querystring: { deviceUdid?: string } }>('/api/schedules', async (request) => ({
        schedules: await options.scheduler.listSchedules(200, request.query.deviceUdid),
    }));
    app.get<{ Querystring: { deviceUdid?: string } }>('/api/executions', async (request) => ({
        executions: await options.scheduler.listExecutions(200, request.query.deviceUdid),
    }));
    app.get<{ Params: { id: string } }>('/api/executions/:id', async (request, reply) => {
        const execution = await options.scheduler.execution(request.params.id);
        return execution ?? reply.code(404).send({ error: 'Execution not found' });
    });
    app.post<{ Body: CreateTaskInput & { assetIds?: string[] } }>('/api/schedules', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.body.deviceUdid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        if (device.disabled) return reply.code(409).send({ error: 'This device is disabled — activate it before scheduling automation' });
        const schedule = await options.scheduler.createTask(
            request.body, device.pluginData[request.body.task.pluginId] ?? {}, new Date(), request.body.assetIds ?? [],
        );
        return reply.code(201).send(schedule);
    });
    app.patch<{
        Params: { id: string };
        Body: { timing?: ScheduleTiming; runWindowMinutes?: number; recurringPublishConfirmed?: boolean };
    }>('/api/schedules/:id', async (request, reply) => {
        const current = await options.scheduler.schedule(request.params.id);
        if (!current) return reply.code(404).send({ error: 'Schedule not found' });
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === current.deviceUdid);
        if (!device) return reply.code(404).send({ error: 'Scheduled device is not registered' });
        const payload = request.body.recurringPublishConfirmed === undefined
            ? current.payload
            : { ...current.payload, recurringPublishConfirmed: request.body.recurringPublishConfirmed };
        const schedule = await options.scheduler.updateSchedule(request.params.id, {
            ...(request.body.timing ? { timing: request.body.timing } : {}),
            ...(request.body.runWindowMinutes !== undefined ? { runWindowMinutes: request.body.runWindowMinutes } : {}),
            task: {
                pluginId: current.pluginId, taskType: current.taskType,
                taskVersion: current.taskVersion, payload,
            },
        }, device.pluginData[current.pluginId] ?? {});
        return schedule ?? reply.code(409).send({ error: 'Completed or cancelled schedules cannot be edited' });
    });
    const changeStatus = async (id: string, status: 'active' | 'paused' | 'cancelled', reply: FastifyReply) => {
        try {
            const schedule = await options.scheduler.setScheduleStatus(id, status);
            return schedule ?? reply.code(404).send({ error: 'Schedule not found' });
        } catch (error) {
            if (error instanceof ScheduleTransitionError) return reply.code(409).send({ error: errorMessage(error) });
            throw error;
        }
    };
    app.post<{ Params: { id: string }; Body: { status: 'active' | 'paused' | 'cancelled' } }>('/api/schedules/:id/status',
        (request, reply) => changeStatus(request.params.id, request.body.status, reply));
    for (const action of ['pause', 'resume', 'cancel'] as const) {
        const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
        app.post<{ Params: { id: string } }>(`/api/schedules/:id/${action}`,
            (request, reply) => changeStatus(request.params.id, status, reply));
    }
    app.post<{ Params: { id: string } }>('/api/executions/:id/stop', async (request, reply) => {
        const result = await options.scheduler.requestStop(request.params.id);
        if (result === 'not-found') return reply.code(404).send({ error: 'Execution not found' });
        if (request.headers['hx-request']) {
            const execution = await options.scheduler.execution(request.params.id);
            return reply.type('text/html').send(await renderActivity(execution?.deviceUdid ?? ''));
        }
        return { result };
    });
    app.post<{ Params: { id: string } }>('/api/executions/:id/retry', async (request, reply) => {
        const execution = await options.scheduler.retryExecution(request.params.id);
        return execution ?? reply.code(409).send({ error: 'Execution is not retryable' });
    });

    app.post('/api/assets', async (request, reply) => {
        const dataRoot = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
        const uploadDirectory = path.join(dataRoot, 'uploads');
        await mkdir(uploadDirectory, { recursive: true });
        const created: Array<{ relativePath: string; originalName: string; mimeType: string; size: number; sha256: string }> = [];
        for await (const part of request.files()) {
            const id = crypto.randomUUID();
            const relativePath = path.join('uploads', id);
            const handle = await open(path.join(dataRoot, relativePath), 'wx', 0o600);
            const hash = crypto.createHash('sha256');
            let size = 0;
            try {
                for await (const chunk of part.file) {
                    const buffer = Buffer.from(chunk);
                    size += buffer.length;
                    hash.update(buffer);
                    await handle.write(buffer);
                }
            } finally {
                await handle.close();
            }
            created.push({ relativePath, originalName: part.filename, mimeType: part.mimetype, size, sha256: hash.digest('hex') });
        }
        return reply.code(201).send(await options.scheduler.registerAssets(created));
    });
    app.delete<{ Body: { assetIds: string[] } }>('/api/assets', async (request, reply) => {
        await options.scheduler.deleteAssets(request.body.assetIds ?? []);
        return reply.code(204).send();
    });

    for (const plugin of options.plugins.list()) {
        if (plugin.registerRoutes) await plugin.registerRoutes({
            app, routePrefix: `/plugins/${plugin.id}`, scheduler: options.scheduler, remote,
            loadDevices: loadRegisteredDevices, saveDevices: saveRegisteredDevices, mutateDevices: mutateRegisteredDevices, renderActivity,
        });
    }

    if (themed) {
        const theme = themed;
        // Templates request these with a ?v=<contenthash>. A versioned request is
        // safe to cache forever; a bare one (bookmark) must revalidate via ETag.
        const asset = (contentType: string, body: string) => {
            const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
            return async (request: FastifyRequest, reply: FastifyReply) => {
                const versioned = Boolean((request.query as { v?: string }).v);
                reply.header('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache')
                    .header('etag', etag);
                if (request.headers['if-none-match'] === etag) return reply.code(304).send();
                return reply.type(contentType).send(body);
            };
        };
        app.get('/assets/styles.css', asset('text/css', theme.styles));
        app.get('/assets/device.js', asset('text/javascript', theme.deviceScript));
        app.get('/assets/tasks.js', asset('text/javascript', theme.tasksScript));
        app.get('/assets/register-device.js', asset('text/javascript', theme.registerDeviceScript));
        app.get('/assets/shell.js', asset('text/javascript', theme.shellScript));
        app.get('/assets/htmx.min.js', asset('text/javascript', theme.htmx));
        // Self-hosted Neue Montreal and the Viralway marks (design system 3.2, 7).
        const binaryAsset = (directory: string, types: Record<string, string>) =>
            async (request: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply) => {
                const name = path.basename(request.params.file);
                const type = types[path.extname(name).toLowerCase()];
                if (!type) return reply.code(404).send({ error: 'Not found' });
                try {
                    const body = await readFile(path.join(themeRoot!, 'assets', directory, name));
                    return reply.header('cache-control', 'public, max-age=86400').type(type).send(body);
                } catch { return reply.code(404).send({ error: 'Not found' }); }
            };
        app.get<{ Params: { file: string } }>('/assets/fonts/:file', binaryAsset('fonts', { '.woff2': 'font/woff2' }));
        app.get<{ Params: { file: string } }>('/assets/img/:file', binaryAsset('img', { '.png': 'image/png', '.svg': 'image/svg+xml' }));
        app.get('/api/fragments/devices', async (_request, reply) => {
            const devices = await registeredWithStatus();
            const active = devices.filter((device) => !device.disabled);
            const disabled = devices.filter((device) => device.disabled);
            const toggleButton = (udid: string, label: string, next: boolean, iconOnly = false) => iconOnly
                ? `<button type="button" class="device-toggle" data-tooltip="${label}" aria-label="${label}" data-toggle-device="${encodeURIComponent(udid)}" data-disabled="${next}">${svgIcon('power', 'icon-sm')}</button>`
                : `<button type="button" class="button secondary xs device-toggle" data-toggle-device="${encodeURIComponent(udid)}" data-disabled="${next}">${label}</button>`;
            const cards = active.map((device) => {
                const accounts = Object.values(device.pluginData).flatMap((value) => {
                    const candidate = value.accounts;
                    return Array.isArray(candidate) ? candidate.filter((entry) => typeof entry === 'string') : [];
                });
                // A still screenshot that refreshes with the 5s fragment poll —
                // not a live MJPEG stream. Streaming every device's screen through
                // the tunnel at once is what made the grid crawl.
                const preview = device.connected
                    ? `<div class="device-preview-frame"><img class="device-preview" src="/api/devices/${encodeURIComponent(device.udid)}/remote/screenshot?t=${Date.now()}" alt="Screen of ${escapeHtml(device.name)}" draggable="false" onerror="this.style.visibility='hidden'"></div>`
                    : '<div class="device-preview-frame" aria-hidden="true"><div class="device-icon"></div></div>';
                const badge = device.connected ? '<span class="badge success">Online</span>' : '<span class="badge">Offline</span>';
                return `<article class="device-card"><a class="device-card-link" href="/devices/${encodeURIComponent(device.udid)}">${preview}<div class="device-copy"><div class="device-copy-row"><h2>${escapeHtml(device.name)}</h2>${badge}</div><p>${device.connected ? `iOS ${escapeHtml(device.connected.osVersion)}` : escapeHtml(device.udid)}</p>${accounts.length ? `<p class="accounts">${accounts.map(escapeHtml).join(', ')}</p>` : ''}</div></a><div class="device-card-actions">${toggleButton(device.udid, 'Disconnect', true, true)}</div></article>`;
            }).join('');
            const disabledPanel = disabled.length
                ? `<section class="disabled-devices"><h2>Disconnected devices (${disabled.length})</h2><ul>${disabled.map((device) => `<li><span>${escapeHtml(device.name)}</span>${toggleButton(device.udid, 'Reconnect', false)}</li>`).join('')}</ul></section>`
                : '';
            const empty = `<div class="empty-state">${svgIcon('smartphone', 'icon-hero')}<h2>No devices yet</h2><p>Register an iPhone and it shows up here.</p><a class="button primary sm" href="/devices/register">Register device</a></div>`;
            const toggleScript = `<script>if(!window.__deviceToggle){window.__deviceToggle=1;document.addEventListener('click',async function(e){var b=e.target.closest('[data-toggle-device]');if(!b)return;e.preventDefault();b.disabled=true;var r=await fetch('/api/devices/'+b.dataset.toggleDevice,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({disabled:b.dataset.disabled==='true'})});if(r.ok){if(window.htmx)htmx.ajax('GET','/api/fragments/devices',{target:'#device-list',swap:'outerHTML'})}else{b.disabled=false;alert(((await r.json().catch(function(){return{}}))||{}).error||'Request failed')}})}</script>`;
            return reply.type('text/html').send(`<section id="device-list" class="device-list" hx-get="/api/fragments/devices" hx-trigger="every 5s" hx-swap="outerHTML" aria-live="polite">${cards || empty}${disabledPanel}${toggleScript}</section>`);
        });
        app.get<{ Params: { udid: string } }>('/api/devices/:udid/fragments/summary', async (request, reply) => {
            const device = (await discoverConnectedDevices()).find(({ udid }) => udid === request.params.udid);
            if (!device) return reply.type('text/html').send('<section id="device-summary" class="panel device-summary"><div><p>Reconnect the USB cable to control this device.</p></div><span class="badge">Disconnected</span></section>');
            const screen = await remote.getScreenInfo(device.udid);
            return reply.type('text/html').send(`<section id="device-summary" class="panel device-summary" data-device-name="${escapeHtml(device.name)}" data-screen-width="${screen.screenSize.width}" data-screen-height="${screen.screenSize.height}"><div><p>iOS ${escapeHtml(device.osVersion)} · ${screen.screenSize.width} × ${screen.screenSize.height} points · ${screen.scale}×</p><code>${escapeHtml(device.udid)}</code></div><span class="badge success">Connected</span></section>`);
        });
        app.get<{ Params: { udid: string } }>('/api/devices/:udid/fragments/activity', async (request, reply) => {
            return reply.type('text/html').send(await renderActivity(request.params.udid));
        });
    }

    app.get('/', async (_request, reply) => {
        if (themed) return reply.type('text/html').send(themed.indexHtml);
        const devices = await registeredWithStatus();
        const cards = devices.map((device) => `<div class="card"><h2>${escapeHtml(device.name)}</h2><p class="muted"><code>${escapeHtml(device.udid)}</code></p><p>${device.disabled ? 'Disconnected' : device.connected ? `Online · iOS ${escapeHtml(device.connected.osVersion)}` : 'Offline'}</p><a class="button" href="/devices/${encodeURIComponent(device.udid)}">Open device</a></div>`).join('');
        const connected = await discoverConnectedDevices();
        const registeredIds = new Set(devices.map(({ udid }) => udid));
        const candidates = connected.filter(({ udid }) => !registeredIds.has(udid)).map((device) => `<option value="${escapeHtml(device.udid)}" data-name="${escapeHtml(device.name)}">${escapeHtml(device.name)} · ${escapeHtml(device.osVersion)}</option>`).join('');
        const registration = candidates ? `<section class="card"><h2>Register connected device</h2><form id="register-device"><select name="udid">${candidates}</select> <button>Register</button></form><p id="register-result" class="muted"></p><script>document.getElementById('register-device').addEventListener('submit',async function(e){e.preventDefault();var s=e.currentTarget.udid;var o=s.options[s.selectedIndex];var r=await fetch('/api/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({udid:o.value,name:o.dataset.name,pluginData:{}})});document.getElementById('register-result').textContent=r.ok?'Registered. Reloading…':(await r.json()).error;if(r.ok)setTimeout(function(){location.reload()},500)});</script></section>` : '';
        return reply.type('text/html').send(renderPage('Devices', `<h1>Devices</h1>${registration}<div class="grid">${cards || '<p>No devices registered.</p>'}</div>`));
    });
    app.get('/devices/register', async (_request, reply) => {
        if (!themed) return reply.type('text/html').send(renderPage('Register device', '<h1>Register device</h1><p>Use <code>POST /api/device-registrations</code> to start device setup.</p>'));
        return reply.type('text/html').send(themed.registerDeviceHtml);
    });
    app.get<{ Params: { udid: string } }>('/devices/:udid', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).type('text/html').send(renderPage('Not found', '<h1>Device not found</h1>'));
        if (themed) {
            const rendered = options.dashboardTheme?.renderDevice
                ? options.dashboardTheme.renderDevice(themed.deviceHtml, device) : themed.deviceHtml;
            return reply.type('text/html').send(rendered.replaceAll('__DEVICE_UDID__', encodeURIComponent(device.udid)));
        }
        const schedules = await options.scheduler.listSchedules(50, device.udid);
        const executions = await options.scheduler.listExecutions(50, device.udid);
        const panels: string[] = [];
        for (const plugin of options.plugins.list()) {
            for (const panel of [...(plugin.devicePanels ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
                try {
                    panels.push(`<section class="card" data-plugin="${escapeHtml(plugin.id)}"><h2>${escapeHtml(panel.title)}</h2>${await readFile(panel.fragmentPath, 'utf8')}</section>`);
                } catch (error) {
                    panels.push(`<section class="card"><h2>${escapeHtml(panel.title)}</h2><p>Panel unavailable: ${escapeHtml(errorMessage(error))}</p></section>`);
                }
            }
        }
        const scheduleRows = schedules.map((item) => `<tr><td>${escapeHtml(item.pluginId)}/${escapeHtml(item.taskType)}</td><td>${escapeHtml(JSON.stringify(item.timing))}<br><span class="muted">Next: ${escapeHtml(item.nextRunAt?.toISOString() ?? '—')}</span></td><td>${escapeHtml(item.status)}</td><td>${item.status === 'active' ? `<button data-schedule="${item.id}" data-status="paused">Pause</button>` : item.status === 'paused' ? `<button data-schedule="${item.id}" data-status="active">Resume</button>` : ''} ${!['cancelled', 'completed'].includes(item.status) ? `<button data-schedule="${item.id}" data-status="cancelled">Cancel</button>` : ''}</td></tr>`).join('');
        const executionRows = executions.map((item) => `<tr><td>${escapeHtml(item.pluginId)}/${escapeHtml(item.taskType)}</td><td>${escapeHtml(item.status)}<br><span class="muted">${escapeHtml(item.scheduledFor.toISOString())}</span></td><td><a href="/api/executions/${item.id}"><code>${escapeHtml(item.id)}</code></a></td><td>${['queued', 'running'].includes(item.status) ? `<button data-stop="${item.id}">Stop</button>` : ['failed', 'stopped'].includes(item.status) ? `<button data-retry="${item.id}">Retry</button>` : ''}</td></tr>`).join('');
        const udidJs = encodeURIComponent(device.udid);
        const passcodeCard = `<section class="card"><h2>Unlock passcode</h2><p class="muted">${device.passcode ? 'A passcode is set.' : 'No passcode set.'} Stored in devices.json, never shown.</p><form id="pc"><input id="pcv" type="password" inputmode="numeric" placeholder="4+ digits" autocomplete="new-password"> <button class="button secondary">Save</button> <button type="button" id="pcc" class="button secondary">Clear</button> <span id="pcr" class="muted"></span></form></section><script>(function(){var f=document.getElementById('pc'),v=document.getElementById('pcv'),r=document.getElementById('pcr');async function set(p){r.textContent='…';var x=await fetch('/api/devices/${udidJs}',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({passcode:p})});if(x.ok){r.textContent=p?'Saved.':'Cleared.';v.value=''}else{r.textContent=((await x.json().catch(function(){return{}})).error)||'Failed'}}f.addEventListener('submit',function(e){e.preventDefault();if(!/^\\d{4,}$/.test(v.value.trim())){r.textContent='4+ digits';return}set(v.value.trim())});document.getElementById('pcc').addEventListener('click',function(){if(confirm('Clear passcode?'))set('')})})();</script>`;
        const controls = `<script>document.addEventListener('click',async function(e){var b=e.target.closest('button');if(!b)return;var url,body,method='POST';if(b.dataset.schedule){url='/api/schedules/'+b.dataset.schedule+'/status';body={status:b.dataset.status}}else if(b.dataset.stop){url='/api/executions/'+b.dataset.stop+'/stop'}else if(b.dataset.retry){url='/api/executions/'+b.dataset.retry+'/retry'}else if(b.dataset.remove){if(!confirm('Remove this device? Its schedules will be cancelled.'))return;url='/api/devices/'+encodeURIComponent(b.dataset.remove);method='DELETE'}else{return}b.disabled=true;var r=await fetch(url,{method:method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):'{}'});if(r.ok){location.href=b.dataset.remove?'/':location.href;if(!b.dataset.remove)location.reload()}else{b.disabled=false;alert((await r.json().catch(function(){return{}})).error||'Request failed')}});</script>`;
        return reply.type('text/html').send(renderPage(device.name, `<h1>${escapeHtml(device.name)}</h1><p><code>${escapeHtml(device.udid)}</code></p>${panels.join('')}<section class="card"><h2>Scheduled and recurring jobs</h2><table><tr><th>Task</th><th>Timing</th><th>Status</th><th>Actions</th></tr>${scheduleRows || '<tr><td colspan="4">No schedules.</td></tr>'}</table></section><section class="card"><h2>Execution history</h2><table><tr><th>Task</th><th>Status</th><th>ID/logs</th><th>Actions</th></tr>${executionRows || '<tr><td colspan="4">No executions.</td></tr>'}</table></section>${passcodeCard}<section class="card"><h2>Danger zone</h2><p class="muted">Removing a device cancels its schedules and forgets its configuration. WebDriverAgent stays installed on the phone.</p><button data-remove="${escapeHtml(device.udid)}" class="button secondary">Remove device</button></section>${controls}`));
    });
    app.get('/tasks', async (_request, reply) => reply.type('text/html').send(
        themed?.tasksHtml ?? renderPage('Tasks', '<h1>Tasks</h1><p>The JSON API exposes schedules and execution history. Installed plugins add task forms to each device page.</p>'),
    ));
    app.get('/docs', async (_request, reply) => reply.type('text/html').send(renderPage('API', '<h1>API</h1><p>Use <code>/api/plugins</code>, <code>/api/devices</code>, <code>/api/schedules</code>, and <code>/api/executions</code>. This route follows the configured authentication policy.</p>')));

    app.setErrorHandler((error, request, reply) => {
        request.log.error(error);
        const failure = error as Error & { statusCode?: number };
        void reply.code(failure.statusCode && failure.statusCode >= 400 ? failure.statusCode : 400)
            .send({ error: failure.message });
    });
    return app;
}
