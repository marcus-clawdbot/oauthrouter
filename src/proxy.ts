/**
 * OAuthRouter proxy (scaffold)
 *
 * ROUTER-001/002 intentionally disabled the legacy BlockRun/x402 proxy.
 *
 * A real OAuth-backed local proxy will be introduced in ROUTER-003+.
 */

export type ProxyOptions = {
  port?: number;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
};

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  void options;
  throw new Error("OAuthRouter proxy not implemented yet (scaffold)");
}
