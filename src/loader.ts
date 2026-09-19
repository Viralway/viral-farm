import type { AuthProvider, ViralFarmPlugin } from './plugin.js';

interface PluginModule {
    default?: ViralFarmPlugin;
    plugin?: ViralFarmPlugin;
}

interface AuthModule {
    default?: AuthProvider;
    authProvider?: AuthProvider;
}

export async function loadPlugins(moduleNames: readonly string[]): Promise<ViralFarmPlugin[]> {
    return Promise.all(moduleNames.filter(Boolean).map(async (moduleName) => {
        const loaded = await import(moduleName) as PluginModule;
        const plugin = loaded.default ?? loaded.plugin;
        if (!plugin?.id || !Array.isArray(plugin.tasks)) {
            throw new Error(`${moduleName} does not export a ViralFarmPlugin`);
        }
        return plugin;
    }));
}

export async function loadAuthProvider(moduleName: string | undefined): Promise<AuthProvider | null> {
    if (!moduleName) return null;
    const loaded = await import(moduleName) as AuthModule;
    const provider = loaded.default ?? loaded.authProvider;
    if (!provider?.id || typeof provider.authenticate !== 'function') {
        throw new Error(`${moduleName} does not export an AuthProvider`);
    }
    return provider;
}

export function configuredPluginModules(value = process.env.VIRAL_FARM_PLUGINS ?? ''): string[] {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}
