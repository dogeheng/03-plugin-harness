import type { Daemon } from "./daemon.ts";
import { type ManagerOptions, PluginManager } from "./plugins/manager.ts";
import { pluginRoutes } from "./plugins/routes.ts";
import { PanelServer, type PanelServerOptions } from "./panels/server.ts";

export { Daemon, VERSION, REPO_ROOT, type DaemonOptions, type Subsystem } from "./daemon.ts";
export { createMockModel, type MockScript } from "./models/mock.ts";
export { MemorySecretStore, KeychainSecretStore, providerService, pluginService } from "./secrets/store.ts";
export { PluginManager, type ManagerOptions, type PluginSummary } from "./plugins/manager.ts";

export { PanelServer, type PanelServerOptions } from "./panels/server.ts";
export interface InstallOptions {
  plugins?: ManagerOptions;
  panels?: PanelServerOptions;
}

/**
 * Wires optional subsystems (plugin manager, panel server, ...) into a daemon.
 * Kept separate from the Daemon constructor so tests can build a bare host.
 */
export function installSubsystems(daemon: Daemon, opts: InstallOptions = {}): { plugins: PluginManager; panels: PanelServer } {
  const plugins = new PluginManager(daemon, opts.plugins);
  const panels = new PanelServer(daemon, plugins, opts.panels);
  plugins.panelServer = panels;
  // Start order: plugins, then the panel server; stop runs in reverse.
  daemon.subsystems.push(plugins, panels);
  daemon.routeRegistrars.push(pluginRoutes(plugins));
  return { plugins, panels };
}
