import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopAPI,
  Session,
  PlatformScan,
  ProviderScan,
  TriageRun,
} from "../src/shared/types";
const api: DesktopAPI = {
  memories: (agent) => ipcRenderer.invoke("memories", agent),
  chooseMemoryDirectory: (agent, mode) => ipcRenderer.invoke("choose-memory-directory", agent, mode),
  discoverHandoffTools: () => ipcRenderer.invoke("handoff-tools"),
  listSourceTasks: (source) => ipcRenderer.invoke("handoff-list", source),
  browseSourceTasks: (source, query) => ipcRenderer.invoke("handoff-browse", source, query),
  importSourceTask: (id, source) => ipcRenderer.invoke("handoff-import", id, source),
  chooseHandoffFile: () => ipcRenderer.invoke("handoff-file"),
  previewHandoff: (goal, target, options) => ipcRenderer.invoke("handoff-preview", goal, target, options),
  scanHandoffAttachments: (session) => ipcRenderer.invoke("handoff-attachments", session),
  addHandoffAttachments: (session) => ipcRenderer.invoke("handoff-attachments-add", session),
  exportHandoffPackage: (token) => ipcRenderer.invoke("handoff-export", token),
  copyHandoff: (token) => ipcRenderer.invoke("handoff-copy", token),
  skills: () => ipcRenderer.invoke("skills"),
  previewSkills: (ids, target) => ipcRenderer.invoke("preview-skills", ids, target),
  copySkills: (ids, target, token, autoConvert) => ipcRenderer.invoke("copy-skills", ids, target, token, autoConvert),
  previewDeleteSkills: (ids) => ipcRenderer.invoke("preview-delete-skills", ids),
  deleteSkills: (ids, token) => ipcRenderer.invoke("delete-skills", ids, token),
  restoreSkill: (id) => ipcRenderer.invoke("restore-skill", id),
  tools: () => ipcRenderer.invoke("tools"),
  discoverTools: () => ipcRenderer.invoke("discover-tools"),
  checkToolUpdates: (id) => ipcRenderer.invoke("check-tool-updates", id),
  pinTool: (id, pinned) => ipcRenderer.invoke("pin-tool", id, pinned),
  chooseToolPath: (productId) =>
    ipcRenderer.invoke("choose-tool-path", productId),
  fileWorkspace: () => ipcRenderer.invoke("file-workspace"),
  chooseFileScope: () => ipcRenderer.invoke("choose-file-scope"),
  cancelFileScan: () => ipcRenderer.invoke("cancel-file-scan"),
  rescanFileScope: (id) => ipcRenderer.invoke("rescan-file-scope", id),
  chooseSensitiveFile: (id) => ipcRenderer.invoke("choose-sensitive-file", id),
  saveFilePolicy: (scopeId, policy, revision) =>
    ipcRenderer.invoke("save-file-policy", scopeId, policy, revision),
  evaluateFilePolicy: (scopeId, resourceId, operation) =>
    ipcRenderer.invoke("evaluate-file-policy", scopeId, resourceId, operation),
  auditEvents: (filter) => ipcRenderer.invoke("audit-events", filter),
  acknowledgeFileAlert: (id) =>
    ipcRenderer.invoke("acknowledge-file-alert", id),
  previewFileAudit: (id, format) =>
    ipcRenderer.invoke("preview-file-audit", id, format),
  exportFileAudit: (id, digest, format) =>
    ipcRenderer.invoke("export-file-audit", id, digest, format),
  triage: () => ipcRenderer.invoke("triage"),
  startTriage: (targetId) => ipcRenderer.invoke("start-triage", targetId),
  stopTriage: () => ipcRenderer.invoke("stop-triage"),
  triageAction: (id, action) => ipcRenderer.invoke("triage-action", id, action),
  observeTriage: (id) => ipcRenderer.invoke("observe-triage", id),
  markTriage: (id) => ipcRenderer.invoke("mark-triage", id),
  verifyTriage: (id, result) => ipcRenderer.invoke("verify-triage", id, result),
  onTriage: (callback) => {
    const listener = (_event: unknown, run: TriageRun) => callback(run);
    ipcRenderer.on("triage-update", listener);
    return () => ipcRenderer.removeListener("triage-update", listener);
  },
  platforms: () => ipcRenderer.invoke("platforms"),
  scanPlatforms: (id) => ipcRenderer.invoke("scan-platforms", id),
  stopPlatforms: () => ipcRenderer.invoke("stop-platforms"),
  copyPlatformResult: (id) => ipcRenderer.invoke("copy-platform-result", id),
  onPlatforms: (callback) => {
    const listener = (_event: unknown, scan: PlatformScan) => callback(scan);
    ipcRenderer.on("platform-update", listener);
    return () => ipcRenderer.removeListener("platform-update", listener);
  },
  providers: () => ipcRenderer.invoke("providers"),
  scanProviders: (id) => ipcRenderer.invoke("scan-providers", id),
  stopProviders: () => ipcRenderer.invoke("stop-providers"),
  copyProviderResult: (id) => ipcRenderer.invoke("copy-provider-result", id),
  onProviders: (callback) => {
    const listener = (_event: unknown, scan: ProviderScan) => callback(scan);
    ipcRenderer.on("provider-update", listener);
    return () => ipcRenderer.removeListener("provider-update", listener);
  },
  overview: () => ipcRenderer.invoke("overview"),
  processes: () => ipcRenderer.invoke("processes"),
  toolUsage: () => ipcRenderer.invoke("tool-usage"),
  connections: (key) => ipcRenderer.invoke("connections", key),
  start: (input) => ipcRenderer.invoke("start", input),
  get: (id) => ipcRenderer.invoke("get", id),
  stop: (id) => ipcRenderer.invoke("stop", id),
  finish: (id) => ipcRenderer.invoke("finish", id),
  extend: (id) => ipcRenderer.invoke("extend", id),
  mark: (id) => ipcRenderer.invoke("mark", id),
  task: (id) => ipcRenderer.invoke("task", id),
  verify: (id, result) => ipcRenderer.invoke("verify", id, result),
  remove: (id) => ipcRenderer.invoke("remove", id),
  settings: (input) => ipcRenderer.invoke("settings", input),
  preview: (id, format) => ipcRenderer.invoke("preview", id, format),
  export: (id, digest, format) =>
    ipcRenderer.invoke("export", id, digest, format),
  onUpdate: (callback) => {
    const listener = (_event: unknown, s: Session) => callback(s);
    ipcRenderer.on("session-update", listener);
    return () => ipcRenderer.removeListener("session-update", listener);
  },
};
contextBridge.exposeInMainWorld("networkLens", api);
