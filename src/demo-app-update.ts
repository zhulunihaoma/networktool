import { version } from "../package.json";
import type { AppUpdateAPI, AppUpdateState } from "./shared/app-update";

export function createDemoAppUpdates(): AppUpdateAPI {
  let state: AppUpdateState = {
    currentVersion: version,
    platform: "浏览器演示",
    preference: "auto",
    status: "idle",
    message: "浏览器演示不检查或下载安装包，请使用桌面本地模式。",
    received: 0,
    total: 0,
    sources: [],
    attempts: [],
  };
  const listeners = new Set<(state: AppUpdateState) => void>();
  const publish = () => {
    listeners.forEach((fn) => fn(structuredClone(state)));
    return structuredClone(state);
  };
  return {
    appUpdate: async () => structuredClone(state),
    setAppUpdateSource: async (preference) => {
      state = { ...state, preference };
      return publish();
    },
    checkAppUpdate: async () => {
      state = {
        ...state,
        status: "idle",
        message: "浏览器演示不访问更新源，请切换到桌面本地模式。",
      };
      return publish();
    },
    downloadAppUpdate: async () => {
      throw new Error("浏览器演示不会下载安装包。");
    },
    cancelAppUpdate: async () => {},
    revealAppUpdate: async () => {
      throw new Error("浏览器演示没有本地安装包。");
    },
    openAppReleasePage: async () => {
      throw new Error("请在桌面本地模式中打开发行版页面。");
    },
    onAppUpdate: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
