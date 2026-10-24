import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isPrivateHost } from "@harness/manifest";
import { Agent } from "undici";

/** Resolves a hostname to all of its addresses (injectable for tests). */
export type Resolver = (hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

export const systemResolver: Resolver = (hostname, cb) => dnsLookup(hostname, { all: true, order: "verbatim" }, cb);

export class PrivateAddressError extends Error {
  readonly code = "EHARNESS_PRIVATE_ADDRESS";
  readonly hostname: string;
  readonly address: string;
  constructor(hostname: string, address: string) {
    super(`${hostname} 解析到本机或内网地址 ${address}`);
    this.hostname = hostname;
    this.address = address;
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `net.connect`-compatible lookup that refuses loopback / private / link-local
 * results unless the hostname is explicitly allowed. Because it runs when the socket
 * connects, the address that is checked is the address that is used: a DNS answer that
 * changes between the policy check and the connection (DNS rebinding) cannot slip through.
 * If any returned address is private the whole answer is refused (rebinding answers
 * often mix public and private records).
 */
export function guardedLookup(isExplicit: (hostname: string) => boolean, resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean; family?: number | string } | number | undefined, cb: LookupCallback): void => {
    const opts = typeof options === "number" ? { family: options } : (options ?? {});
    const family = opts.family === "IPv4" ? 4 : opts.family === "IPv6" ? 6 : opts.family;
    resolve(hostname, (err, addrs) => {
      if (err) return cb(err, []);
      if (!isExplicit(hostname)) {
        const bad = addrs.find((a) => isPrivateHost(a.address));
        if (bad) return cb(new PrivateAddressError(hostname, bad.address) as unknown as NodeJS.ErrnoException, []);
      }
      const list = family === 4 || family === 6 ? addrs.filter((a) => a.family === family) : addrs;
      const first = list[0];
      if (!first) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname }), []);
      if (opts.all) cb(null, list);
      else cb(null, first.address, first.family);
    });
  };
}

/** An undici dispatcher whose connections go through {@link guardedLookup}. */
export function createGuardedAgent(isExplicit: (hostname: string) => boolean, resolve?: Resolver): Agent {
  return new Agent({ connect: { lookup: guardedLookup(isExplicit, resolve) as never }, keepAliveTimeout: 4_000 });
}

/** Finds a PrivateAddressError anywhere in an error's cause chain (fetch wraps connect errors). */
export function privateAddressCause(e: unknown): PrivateAddressError | null {
  for (let cur = e, depth = 0; cur && depth < 6; cur = (cur as { cause?: unknown }).cause, depth++) {
    if (cur instanceof PrivateAddressError) return cur;
    if ((cur as { code?: string }).code === "EHARNESS_PRIVATE_ADDRESS") return cur as PrivateAddressError;
  }
  return null;
}
