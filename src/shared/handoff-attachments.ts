/** Public metadata only. Binary data and source paths stay in the main process. */
export interface HandoffAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: "ready" | "missing" | "unsupported" | "error";
  note: string;
  messageId: string;
  origin: "stored" | "local-image" | "reference" | "manual";
  sha256?: string;
}
export interface HandoffAttachmentScan {
  token: string;
  entries: HandoffAttachment[];
  complete: boolean;
  warnings: string[];
}
export interface HandoffAttachmentSelection {
  packAttachments?: boolean;
  attachmentIds?: string[];
  attachmentScanToken?: string;
  allowPartialAttachments?: boolean;
}
export interface HandoffPackageSummary {
  entries: HandoffAttachment[];
  bytes: number;
  omitted: number;
  complete: boolean;
}
export const attachmentSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
