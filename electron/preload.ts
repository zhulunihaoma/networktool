import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopAPI,
  Session,
  PlatformScan,
  ProviderScan,
  TriageRun,
} from "../src/shared/types";
import type { AppUpdateState } from "../src/shared/app-update";
const api: DesktopAPI = {
  security: {
    securityTrustCodex: () => ipcRenderer.invoke("security-trust-codex"),
    securityOverview: () => ipcRenderer.invoke("security-overview"),
    securityTimeline: (filter) =>
      ipcRenderer.invoke("security-timeline", filter),
    securityDoctor: () => ipcRenderer.invoke("security-doctor"),
    securityLastDoctor: () => ipcRenderer.invoke("security-last-doctor"),
    securityForwardSettings: () =>
      ipcRenderer.invoke("security-forward-settings"),
    securitySaveForwardSettings: (settings) =>
      ipcRenderer.invoke("security-forward-save", settings),
    securityForwardStats: () => ipcRenderer.invoke("security-forward-stats"),
    securityForwardNow: () => ipcRenderer.invoke("security-forward-now"),
    securityForwardExport: () => ipcRenderer.invoke("security-forward-export"),
    securityIgnoreFinding: (id, ignored) =>
      ipcRenderer.invoke("security-ignore", id, ignored),
    securityRevealFinding: (id) =>
      ipcRenderer.invoke("security-reveal-finding", id),
    securityInventory: (rebaseline) =>
      ipcRenderer.invoke("security-inventory", rebaseline),
    securityPreview: (kind, target) =>
      ipcRenderer.invoke("security-preview", kind, target),
    securityApply: (token) => ipcRenderer.invoke("security-apply", token),
    securitySelfCheck: (tool) =>
      ipcRenderer.invoke("security-self-check", tool),
    securitySetAutoProtect: (enabled) =>
      ipcRenderer.invoke("security-auto-protect", enabled),
    securityRunAutoProtect: () =>
      ipcRenderer.invoke("security-run-auto-protect"),
    securityChooseProject: () => ipcRenderer.invoke("security-choose-project"),
    securityCheckMcp: (text) => ipcRenderer.invoke("security-check-mcp", text),
    securityCopyMcp: (text) => ipcRenderer.invoke("security-copy-mcp", text),
    securitySavePolicy: (policy) =>
      ipcRenderer.invoke("security-save-policy", policy),
    securityAddException: (id) =>
      ipcRenderer.invoke("security-add-exception", id),
    securityRemoveException: (rule, project) =>
      ipcRenderer.invoke("security-remove-exception", rule, project),
    securityRetroScan: () => ipcRenderer.invoke("security-retro-scan"),
    securityIncidents: (filter) =>
      ipcRenderer.invoke("security-incidents", filter),
    securityChains: (filter) => ipcRenderer.invoke("security-chains", filter),
    securityExport: (format) => ipcRenderer.invoke("security-export", format),
    onSecurity: (callback) => {
      const listener = (
        _event: unknown,
        value: import("../src/shared/security").SecurityEvent,
      ) => callback(value);
      ipcRenderer.on("security-event", listener);
      return () => ipcRenderer.removeListener("security-event", listener);
    },
    onSecurityProgress: (callback) => {
      const listener = (
        _event: unknown,
        value: import("../src/shared/security").SecurityProgress,
      ) => callback(value);
      ipcRenderer.on("security-progress", listener);
      return () => ipcRenderer.removeListener("security-progress", listener);
    },
  },
  appUpdate: () => ipcRenderer.invoke("app-update-state"),
  setAppUpdateSource: (source) => ipcRenderer.invoke("app-update-source", source),
  checkAppUpdate: () => ipcRenderer.invoke("app-update-check"),
  downloadAppUpdate: () => ipcRenderer.invoke("app-update-download"),
  cancelAppUpdate: () => ipcRenderer.invoke("app-update-cancel"),
  revealAppUpdate: () => ipcRenderer.invoke("app-update-reveal"),
  openAppReleasePage: (source) => ipcRenderer.invoke("app-update-page", source),
  onAppUpdate: (callback) => {
    const listener = (_event: unknown, state: AppUpdateState) => callback(state);
    ipcRenderer.on("app-update", listener);
    return () => ipcRenderer.removeListener("app-update", listener);
  },
  memories: (agent) => ipcRenderer.invoke("memories", agent),
  chooseMemoryDirectory: (agent, mode) => ipcRenderer.invoke("choose-memory-directory", agent, mode),
  discoverHandoffTools: () => ipcRenderer.invoke("handoff-tools"),
  listSourceTasks: (source) => ipcRenderer.invoke("handoff-list", source),
  browseSourceTasks: (source, query) => ipcRenderer.invoke("handoff-browse", source, query),
  readHandoffContext: (id, offset) => ipcRenderer.invoke("handoff-context", id, offset),
  exportHandoffContext: (id) => ipcRenderer.invoke("handoff-context-export", id),
  verifyHandoffHistory: (source) => ipcRenderer.invoke("handoff-verify", source),
  cancelHandoffVerification: () => ipcRenderer.invoke("handoff-verify-cancel"),
  getHandoffVerification: () => ipcRenderer.invoke("handoff-verify-progress"),
  addHandoffSourceDirectory: (source) => ipcRenderer.invoke("handoff-source-directory", source),
  importSourceTask: (id, source) => ipcRenderer.invoke("handoff-import", id, source),
  chooseHandoffFile: () => ipcRenderer.invoke("handoff-file"),
  previewHandoff: (goal, target, options) => ipcRenderer.invoke("handoff-preview", goal, target, options),
  scanHandoffAttachments: (session) => ipcRenderer.invoke("handoff-attachments", session),
  addHandoffAttachments: (session) => ipcRenderer.invoke("handoff-attachments-add", session),
  exportHandoffPackage: (token) => ipcRenderer.invoke("handoff-export", token),
  copyHandoff: (token) => ipcRenderer.invoke("handoff-copy", token),
  skills: () => ipcRenderer.invoke("skills"),
  skillPreference: (id, kind, value) => ipcRenderer.invoke("skill-preference", id, kind, value),
  compareSkills: (left, right) => ipcRenderer.invoke("compare-skills", left, right),
  previewMergeSkills: (keepId, ids) => ipcRenderer.invoke("preview-merge-skills", keepId, ids),
  mergeSkills: (keepId, ids, token) => ipcRenderer.invoke("merge-skills", keepId, ids, token),
  skillTidy: () => ipcRenderer.invoke("skill-tidy"),
  applySkillTidy: (ids, token) => ipcRenderer.invoke("apply-skill-tidy", ids, token),
  revertSkillMove: (id) => ipcRenderer.invoke("revert-skill-move", id),
  previewSkills: (ids, target) =>
    ipcRenderer.invoke("preview-skills", ids, target),
  copySkills: (ids, target, token, autoConvert, riskAcknowledged) =>
    ipcRenderer.invoke(
      "copy-skills",
      ids,
      target,
      token,
      autoConvert,
      riskAcknowledged,
    ),
  previewDeleteSkills: (ids) =>
    ipcRenderer.invoke("preview-delete-skills", ids),
  deleteSkills: (ids, token) => ipcRenderer.invoke("delete-skills", ids, token),
  restoreSkill: (id) => ipcRenderer.invoke("restore-skill", id),
  tools: () => ipcRenderer.invoke("tools"),
  discoverTools: () => ipcRenderer.invoke("discover-tools"),
  checkToolUpdates: (id) => ipcRenderer.invoke("check-tool-updates", id),
  pinTool: (id, pinned) => ipcRenderer.invoke("pin-tool", id, pinned),
  chooseToolPath: (productId) =>
    ipcRenderer.invoke("choose-tool-path", productId),
  trialFilePolicy: (scope, draft, expected) => ipcRenderer.invoke("trial-file-policy", scope, draft, expected),
  publishFilePolicy: id => ipcRenderer.invoke("publish-file-policy", id),
  rollbackFilePolicy: (scope, resource, expected) => ipcRenderer.invoke("rollback-file-policy", scope, resource, expected),
  reconfirmFileCandidate: (scope,resource) => ipcRenderer.invoke("reconfirm-file-candidate",scope,resource),
  reviewFileCandidate: (scope, resource, deferred) => ipcRenderer.invoke("review-file-candidate", scope, resource, deferred),
  startFileTask: (scope, resource, kind) => ipcRenderer.invoke("start-file-task", scope, resource, kind),
  grantFileTask: (task, reason) => ipcRenderer.invoke("grant-file-task", task, reason),
  runFileTask: task => ipcRenderer.invoke("run-file-task", task),
  revokeFileGrant: id => ipcRenderer.invoke("revoke-file-grant", id),
  exportFileTaskCopy: (task, digest) => ipcRenderer.invoke("export-file-task-copy", task, digest),
  retryFileDeployment: () => ipcRenderer.invoke("retry-file-deployment"),
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
