import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, GIT_INSIGHT, MISBEHAVE, PROBE, pluginSource, test } from "./fixtures.ts";

test.describe("登录", () => {
  test("未登录时引导从终端登录，用一次性链接登录后进入会话页", async ({ page, harness }) => {
    await page.goto(harness.base);
    await expect(page.getByText("需要从终端登录")).toBeVisible();
    await expect(page.getByText("harness open")).toBeVisible();
    await harness.login(page);
    await expect(page.getByText("开始一个对话")).toBeVisible();
    // A used login code cannot be replayed.
    const ctx = await page.context().browser()?.newContext();
    const p2 = await ctx?.newPage();
    const code = harness.host.daemon.auth.mintLoginCode();
    await p2?.goto(`${harness.base}/auth/callback?code=${code}`);
    const r = await p2?.goto(`${harness.base}/auth/callback?code=${code}`);
    expect(r?.status()).toBeGreaterThanOrEqual(400);
    await ctx?.close();
  });
});

test.describe("插件管理", () => {
  test("插件中心列出已安装插件，可以禁用和重新启用", async ({ page, harness }) => {
    await harness.install(pluginSource.gitInsight);
    await harness.login(page, "/plugins");
    const card = page.locator(`[data-testid=plugin-card][data-plugin="${GIT_INSIGHT}"]`);
    await expect(card).toContainText("Git Insight");
    await expect(card).toContainText("3 个工具");
    await expect(card).toContainText("/changelog");
    await expect(page.getByTestId("nav-panels")).toContainText("提交时间线");

    await card.getByTestId("plugin-toggle").click();
    await expect(page.getByText("Git Insight 已禁用")).toBeVisible();
    await expect(card.getByTestId("plugin-state")).toHaveAttribute("data-state", "disabled");
    // Its panel disappears from the navigation; its tools disappear from the agent.
    await expect(page.getByTestId("nav-panels")).toHaveCount(0);
    const cmds = await harness.api<{ commands: unknown[] }>("GET", "/api/commands");
    expect(cmds.commands).toHaveLength(0);

    await card.getByTestId("plugin-toggle").click();
    await expect(page.getByText("Git Insight 已启用")).toBeVisible();
    await expect(page.getByTestId("nav-panels")).toContainText("提交时间线");
  });

  test("从文件夹安装：先审查隔离方式和权限，同意后安装并进入详情页", async ({ page, harness }) => {
    await harness.login(page, "/plugins");
    await page.getByTestId("install-open").click();
    await page.getByTestId("install-source").fill(pluginSource.probe);
    await page.getByTestId("install-inspect").click();
    const review = page.getByTestId("install-review");
    await expect(review).toContainText("它会怎样运行");
    await expect(review.getByTestId("permission-list")).toContainText("显示面板");
    await page.getByTestId("install-confirm").click();
    await expect(page).toHaveURL(new RegExp(`/plugins/${PROBE.replace(/\./g, "\\.")}$`));
    await expect(page.getByTestId("plugin-title")).toHaveText("Panel Probe (test fixture)");
  });

  test("安装前能看到清单错误，并且不能安装", async ({ page, harness }) => {
    await harness.login(page, "/plugins");
    await page.getByTestId("install-open").click();
    await page.getByTestId("install-source").fill(join(harness.repo, "not-a-plugin"));
    await page.getByTestId("install-inspect").click();
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    await expect(page.getByTestId("install-review")).toHaveCount(0);
  });

  test("插件详情：保存设置、授予并撤销可选权限、查看健康状况", async ({ page, harness }) => {
    await harness.install(pluginSource.gitInsight);
    await harness.login(page, `/plugins/${GIT_INSIGHT}`);
    await expect(page.getByTestId("plugin-title")).toHaveText("Git Insight");
    // Plugins start on first use; until then the page says when the sandbox applies.
    await page.getByRole("tab", { name: "健康与日志" }).click();
    await expect(page.getByTestId("plugin-sandbox")).toHaveText("Seatbelt 沙箱：插件启动时启用");

    await page.getByRole("tab", { name: "设置" }).click();
    await page.locator("[data-field=maxCommits] input").fill("50");
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.getByText("设置已保存")).toBeVisible();
    const detail = await harness.api<{ settings: Record<string, unknown> }>("GET", `/api/plugins/${GIT_INSIGHT}`);
    expect(detail.settings.maxCommits).toBe(50);

    await page.getByRole("tab", { name: "权限" }).click();
    const llm = page.locator("[data-permission='llm.invoke']");
    await expect(llm).toContainText("未授予");
    await llm.getByRole("button", { name: "授予" }).click();
    await expect(llm).toContainText("已授予");
    await llm.getByRole("button", { name: "撤销" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "撤销" }).click();
    await expect(llm).toContainText("未授予");

    await page.getByRole("tab", { name: "健康与日志" }).click();
    await expect(page.getByText("调用次数")).toBeVisible();
    await page.getByRole("button", { name: "重启" }).click();
    await expect(page.getByTestId("plugin-sandbox")).toHaveText("Seatbelt 沙箱：已启用");
  });
});

test.describe("会话", () => {
  test("Agent 调用插件提供的工具，界面显示工具卡片和回答", async ({ page, harness }) => {
    await harness.install(pluginSource.gitInsight);
    await harness.login(page);
    await page.getByTestId("composer").fill("这个仓库最近改了什么？");
    await page.getByTestId("composer").press("Enter");
    const card = page.locator("[data-testid=tool-card][data-tool=git_log]");
    await expect(card).toHaveAttribute("data-status", "ok");
    await expect(card).toContainText(GIT_INSIGHT);
    await expect(page.getByTestId("msg-assistant").last()).toContainText("docs: third");
    // Expanding the card shows the real tool output from the plugin process.
    await card.getByRole("button").first().click();
    await expect(card).toContainText("fix: second");
    // The conversation survives a reload (persisted in SQLite).
    await page.reload();
    await expect(page.locator("[data-testid=tool-card][data-tool=git_log]")).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("msg-user")).toContainText("最近改了什么");
  });

  test("工具需要审批时弹窗：允许后继续，拒绝后工具被拦截", async ({ page, harness }) => {
    await harness.install(pluginSource.gitInsight);
    await harness.api("PATCH", "/api/config", { approvals: { read: "ask" } });
    await harness.login(page);

    await page.getByTestId("composer").fill("看看状态");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("approval-dialog")).toContainText("git_status");
    await expect(page.locator("[data-testid=tool-card][data-tool=git_status]")).toHaveAttribute("data-status", "awaiting");
    await page.getByTestId("approval-allow").click();
    await expect(page.locator("[data-testid=tool-card][data-tool=git_status]")).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("msg-assistant").last()).toContainText("工作区是干净的");

    await page.getByTestId("composer").fill("再看看状态");
    await page.getByTestId("composer").press("Enter");
    await page.getByTestId("approval-deny").click();
    await expect(page.locator("[data-testid=tool-card][data-tool=git_status]").last()).toHaveAttribute("data-status", /blocked|error/);
  });

  test("插件崩溃时，工具卡片说明原因，宿主和界面照常工作", async ({ page, harness }) => {
    await harness.install(pluginSource.misbehave);
    await harness.install(pluginSource.gitInsight);
    await harness.api("PATCH", "/api/config", { approvals: { read: "auto", write: "auto", exec: "auto", network: "auto" } });
    await harness.login(page);
    await page.getByTestId("composer").fill("让它崩溃");
    await page.getByTestId("composer").press("Enter");
    const card = page.locator("[data-testid=tool-card][data-tool=crash]");
    await expect(card).toHaveAttribute("data-status", "error");
    await expect(card).toContainText(/退出|崩溃|exit/);
    // A fresh transcript must preserve the failure, not turn it into a successful call.
    await expect(page.getByTestId("msg-assistant").last()).toContainText("崩溃");
    await expect.poll(() => harness.host.plugins.get(MISBEHAVE)?.instance?.state).toBe("active");
    // Finish recovery-triggered queries before deliberately navigating away.
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(card).toHaveAttribute("data-status", "error");
    await expect(card).toContainText(/退出|崩溃|exit/);
    // The host is unaffected: another plugin keeps working in the same session.
    await page.getByTestId("composer").fill("最近改了什么");
    await page.getByTestId("composer").press("Enter");
    await expect(page.locator("[data-testid=tool-card][data-tool=git_log]")).toHaveAttribute("data-status", "ok");
    await page.goto(`${harness.base}/plugins/${MISBEHAVE}`);
    await page.getByRole("tab", { name: "健康与日志" }).click();
    await expect(page.getByText("最近一次错误")).toBeVisible();
  });
});

test.describe("插件界面扩展", () => {
  test("时间线面板运行在隔离 iframe 中，通过宿主调用插件工具渲染提交", async ({ page, harness }) => {
    await harness.install(pluginSource.gitInsight);
    await harness.login(page);
    const panel = page.getByTestId(`panel-${GIT_INSIGHT}-timeline`);
    await expect(panel).toBeVisible();
    const frame = panel.frameLocator("iframe");
    await expect(frame.getByText("docs: third")).toBeVisible();
    await expect(frame.getByText("fix: second")).toBeVisible();
    // The iframe is on a different origin and sandboxed without allow-same-origin.
    const iframe = panel.locator("iframe");
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms");
    const src = await iframe.getAttribute("src");
    expect(new URL(src ?? "").port).not.toBe(String(harness.host.daemon.port));
    // Dark mode reaches the panel through the bridge.
    await page.getByRole("button", { name: "深色" }).click();
    await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("⌘K 运行插件命令 /changelog，确认后由宿主写入 CHANGELOG.md", async ({ page, harness }) => {
    await harness.install(pluginSource.gitInsight);
    await harness.login(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByPlaceholder("搜索命令、页面…").fill("changelog");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("command-dialog")).toBeVisible();
    await page.getByTestId("command-run").click();
    await expect(page.getByTestId("command-output")).toContainText("second");
    const action = page.getByTestId("command-action");
    await expect(action).toContainText("CHANGELOG.md");
    expect(existsSync(join(harness.repo, "CHANGELOG.md"))).toBe(false);
    await action.getByRole("button", { name: "确认写入" }).click();
    await expect(action).toContainText("已写入");
    expect(readFileSync(join(harness.repo, "CHANGELOG.md"), "utf8")).toContain("second");
  });

  test("隔离探针：面板的联网、读宿主页面、弹窗、跳转等越界尝试全部失败", async ({ page, harness }) => {
    await harness.install(pluginSource.probe);
    await harness.login(page, `/panels/${PROBE}/probe`);
    const frame = page.frameLocator("iframe");
    const results = frame.locator("#results");
    await expect(results).not.toHaveText("running", { timeout: 20_000 });
    const r = JSON.parse((await results.textContent()) ?? "{}") as Record<string, { blocked: boolean; detail: string }>;
    // sendBeacon/form submit only report "queued"/"submitted"; whether anything left is checked below.
    for (const [name, v] of Object.entries(r)) if (name !== "send-beacon" && name !== "form-submit") expect(v.blocked, `${name}: ${v.detail}`).toBe(true);
    const formBlocked = page.waitForEvent("console", { timeout: 10_000, predicate: (msg) => msg.text().includes("form-action") });
    await frame.locator("#submit-probe").click();
    await formBlocked;
    expect(harness.leaks).toEqual([]);
    await page.getByRole("button", { name: "重新加载面板" }).click();
    await expect(frame.locator("#results")).toContainText('"fetch-external"');
    // Last, the probe navigates its own frame to an external URL. The main page's CSP (frame-src)
    // makes the browser refuse it, and the host tells the user what happened.
    await frame.locator("#escape").click();
    await expect(page.getByTestId("panel-violation")).toBeVisible({ timeout: 10_000 });
    expect(harness.leaks, "requests that tried to leave the machine").toEqual([]);
  });
});
