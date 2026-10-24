import { createRootRoute, createRoute, createRouter, Link } from "@tanstack/react-router";
import { Layout } from "./components/Layout.tsx";
import { Empty } from "./components/ui.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { PluginDetailPage } from "./pages/PluginDetail.tsx";
import { PluginsPage } from "./pages/Plugins.tsx";
import { PanelPage, SettingsPage } from "./pages/Settings.tsx";

const rootRoute = createRootRoute({
  component: Layout,
  notFoundComponent: () => (
    <div className="p-8">
      <Empty title="页面不存在">
        <Link to="/" className="text-accent hover:underline">
          回到会话
        </Link>
      </Empty>
    </div>
  ),
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ChatPage,
  validateSearch: (s: Record<string, unknown>): { s?: string } => (typeof s.s === "string" ? { s: s.s } : {}),
});
const pluginsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/plugins", component: PluginsPage });
const pluginDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/plugins/$id", component: PluginDetailPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const panelRoute = createRoute({ getParentRoute: () => rootRoute, path: "/panels/$pluginId/$panelId", component: PanelPage });

const routeTree = rootRoute.addChildren([chatRoute, pluginsRoute, pluginDetailRoute, settingsRoute, panelRoute]);

export const router = createRouter({ routeTree, defaultPreload: false, scrollRestoration: true });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
