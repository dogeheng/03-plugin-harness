import { registerSecretValue } from "@harness/shared";

/**
 * Secrets never live in config files or the database. The keychain backend is
 * the default; the memory backend exists for tests (HARNESS_SECRETS_BACKEND=memory)
 * so automated runs never trigger macOS keychain dialogs.
 */
export interface SecretStore {
  readonly kind: "keychain" | "memory";
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

export const SERVICE_PREFIX = "dev.harness";

export function providerService(providerId: string): string {
  return `${SERVICE_PREFIX}.provider.${providerId}`;
}

export function pluginService(pluginId: string): string {
  return `${SERVICE_PREFIX}.plugin.${pluginId}`;
}

export class MemorySecretStore implements SecretStore {
  readonly kind = "memory" as const;
  private readonly map = new Map<string, string>();
  async get(service: string, account: string) {
    const v = this.map.get(`${service}\u0000${account}`) ?? null;
    registerSecretValue(v);
    return v;
  }
  async set(service: string, account: string, value: string) {
    registerSecretValue(value);
    this.map.set(`${service}\u0000${account}`, value);
  }
  async delete(service: string, account: string) {
    return this.map.delete(`${service}\u0000${account}`);
  }
}

export class KeychainSecretStore implements SecretStore {
  readonly kind = "keychain" as const;
  private entryCtor: Promise<typeof import("@napi-rs/keyring").Entry>;
  constructor() {
    this.entryCtor = import("@napi-rs/keyring").then((m) => m.Entry);
  }
  async get(service: string, account: string) {
    const Entry = await this.entryCtor;
    try {
      const v = new Entry(service, account).getPassword() ?? null;
      registerSecretValue(v);
      return v;
    } catch {
      return null;
    }
  }
  async set(service: string, account: string, value: string) {
    const Entry = await this.entryCtor;
    registerSecretValue(value);
    new Entry(service, account).setPassword(value);
  }
  async delete(service: string, account: string) {
    const Entry = await this.entryCtor;
    try {
      return new Entry(service, account).deletePassword() !== false;
    } catch {
      return false;
    }
  }
}

export function createSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  return env.HARNESS_SECRETS_BACKEND === "memory" ? new MemorySecretStore() : new KeychainSecretStore();
}
