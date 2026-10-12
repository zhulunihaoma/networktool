import type { DesktopAPI, ProviderScan } from "./types";

type ScanAPI = Pick<DesktopAPI, "providers" | "scanProviders">;
const pending = new WeakMap<ScanAPI, Promise<ProviderScan>>();

// Share initialization across StrictMode effects; existing scans are never restarted.
export function autoProviderScan(api: ScanAPI): Promise<ProviderScan> {
  const existing = pending.get(api);
  if (existing) return existing;
  const request = api.providers().then((scan) =>
    scan.status === "idle" ? api.scanProviders() : scan,
  );
  pending.set(api, request);
  const clear = () => pending.delete(api);
  void request.then(clear, clear);
  return request;
}
