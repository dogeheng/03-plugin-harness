import { describe, expect, it } from "vitest";
import { isExplicitHost, isIpLiteral, isPrivateHost, matchHost } from "../src/index.ts";

describe("isPrivateHost", () => {
  it.each([
    "127.0.0.1",
    "127.8.9.10",
    "10.1.2.3",
    "100.64.1.1", // CGNAT / Tailscale
    "169.254.169.254", // link-local / cloud metadata
    "0.0.0.0",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.8",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "[fe80::1]",
    "fd00::1",
    "fc12:3456::1",
    "ff02::1",
    "[::ffff:7f00:1]", // IPv4-mapped 127.0.0.1 as WHATWG URL prints it
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1", // NAT64 of 10.0.0.1
    "localhost",
    "LOCALHOST.",
    "api.localhost",
    "printer.local",
    "db.internal",
    "nas.home.arpa",
  ])("treats %s as private", (h) => {
    expect(isPrivateHost(h)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "100.128.0.1", "172.32.0.1", "192.169.0.1", "2001:4860:4860::8888", "[2606:4700::1111]", "::ffff:8.8.8.8", "example.com", "localhost.example.com"])(
    "treats %s as public",
    (h) => {
      expect(isPrivateHost(h)).toBe(false);
    },
  );

  it("catches the obfuscated forms that URL parsing normalises", () => {
    for (const u of ["http://0x7f.1/", "http://2130706433/", "http://0177.0.0.1/", "http://[::ffff:127.0.0.1]/", "http://[0:0:0:0:0:0:0:1]/"]) {
      expect(isPrivateHost(new URL(u).hostname), u).toBe(true);
    }
  });

  it("rejects malformed addresses instead of guessing", () => {
    expect(isIpLiteral("1.2.3.256")).toBe(false);
    expect(isIpLiteral("1::2::3")).toBe(false);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
  });
});

describe("host allowlists", () => {
  it("wildcards never reach private hosts; literal entries do", () => {
    expect(matchHost(["*"], new URL("https://example.com/x"))).toBe(true);
    expect(matchHost(["*"], new URL("http://127.0.0.1/"))).toBe(false);
    expect(matchHost(["*.local"], new URL("http://printer.local/"))).toBe(false);
    expect(matchHost(["127.0.0.1:8080"], new URL("http://127.0.0.1:8080/"))).toBe(true);
    expect(matchHost(["127.0.0.1:8080"], new URL("http://127.0.0.1:9090/"))).toBe(false);
  });

  it("isExplicitHost only counts literal host entries", () => {
    expect(isExplicitHost(["*", "*.example.com"], "api.example.com")).toBe(false);
    expect(isExplicitHost(["api.example.com"], "api.example.com")).toBe(true);
    expect(isExplicitHost(["127.0.0.1:8080"], "127.0.0.1")).toBe(true);
    expect(isExplicitHost(["*"], "127.0.0.1")).toBe(false);
  });
});
