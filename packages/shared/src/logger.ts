import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino, { type Logger } from "pino";
import { redact, redactDeep } from "./redact.ts";

export type { Logger } from "pino";

export interface LoggerOptions {
  name: string;
  level?: string;
  /** When set, logs go to this file; otherwise to stderr. */
  file?: string;
}

/**
 * Creates a structured logger whose every argument is redacted before
 * serialisation, so secrets can never reach a log sink.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? process.env.HARNESS_LOG_LEVEL ?? "info";
  let destination: pino.DestinationStream;
  if (opts.file) {
    mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 });
    // Synchronous: the daemon logs little, and a crash must never lose its last lines.
    destination = pino.destination({ dest: opts.file, mkdir: true, sync: true });
  } else {
    destination = pino.destination(2);
  }
  return pino(
    {
      name: opts.name,
      level,
      base: { pid: process.pid },
      hooks: {
        logMethod(args, method) {
          const safe = args.map((a) => (typeof a === "string" ? redact(a) : redactDeep(a)));
          return method.apply(this, safe as Parameters<typeof method>);
        },
      },
      formatters: {
        log(obj) {
          return redactDeep(obj);
        },
      },
    },
    destination,
  );
}
