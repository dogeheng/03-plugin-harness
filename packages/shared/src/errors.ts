/**
 * HPP error codes. Custom codes live in the implementation-defined range
 * -32000..-32019 so they never collide with the -32020..-32099 range MCP
 * reserves for its specification (see report section 4.6).
 */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  PermissionDenied: -32001,
  Timeout: -32002,
  Cancelled: -32003,
  IncompatibleProtocol: -32004,
  InvalidRegistration: -32005,
  QuotaExceeded: -32006,
  InvalidOutput: -32007,
  NotActive: -32008,
  PluginError: -32009,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorName: Record<number, string> = Object.fromEntries(
  Object.entries(ErrorCode).map(([k, v]) => [v, k]),
);

export class HarnessError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.data = data;
  }
  toJSON() {
    return { code: this.code, name: ErrorName[this.code] ?? "Error", message: this.message, data: this.data };
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
