import sources from "../../updates/sources.json";

export const UPDATE_SOURCES = sources;
export const UPDATE_SOURCE_IDS = ["gitee", "github"] as const;
export type UpdateSource = (typeof UPDATE_SOURCE_IDS)[number];
export type UpdatePreference = "auto" | UpdateSource;
export interface UpdateAsset {
  name: string;
  size: number;
  sha256: string;
  urls: Record<UpdateSource, string>;
}
export interface AppRelease {
  version: string;
  publishedAt: string;
  notes: string;
  assets: Record<string, UpdateAsset>;
}
export interface UpdateManifest {
  schemaVersion: 1;
  release: AppRelease | null;
}
export interface UpdateSourceResult {
  source: UpdateSource;
  status: "ok" | "empty" | "error";
  version?: string;
  message: string;
}
export interface AppUpdateState {
  currentVersion: string;
  platform: string;
  preference: UpdatePreference;
  status:
    | "idle"
    | "checking"
    | "available"
    | "current"
    | "unpublished"
    | "unsupported"
    | "downloading"
    | "verifying"
    | "ready"
    | "cancelled"
    | "error";
  message: string;
  checkedAt?: number;
  sources: UpdateSourceResult[];
  release?: {
    version: string;
    notes: string;
    publishedAt: string;
    fileName?: string;
    size?: number;
  };
  activeSource?: UpdateSource;
  received: number;
  total: number;
  attempts: { source: UpdateSource; message: string }[];
}
export interface AppUpdateAPI {
  appUpdate(): Promise<AppUpdateState>;
  setAppUpdateSource(source: UpdatePreference): Promise<AppUpdateState>;
  checkAppUpdate(): Promise<AppUpdateState>;
  downloadAppUpdate(): Promise<AppUpdateState>;
  cancelAppUpdate(): Promise<void>;
  revealAppUpdate(): Promise<void>;
  openAppReleasePage(source: UpdateSource): Promise<void>;
  onAppUpdate(callback: (state: AppUpdateState) => void): () => void;
}

export function updateAssetURL(
  source: UpdateSource,
  version: string,
  name: string,
) {
  return `${UPDATE_SOURCES[source].repository}/releases/download/v${version}/${encodeURIComponent(name)}`;
}

// Release feeds contain stable versions; current development versions may have a prerelease suffix.
export function compareAppVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match =
      /^v?(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        value,
      );
    if (!match) throw new Error("无法识别应用版本号。");
    return { parts: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
  };
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++)
    if (a.parts[i] !== b.parts[i]) return Math.sign(a.parts[i] - b.parts[i]);
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
