export interface SharedFilesPlugin {
  getPendingFiles(): Promise<{ paths: string[] }>;
  clearPendingFiles(): Promise<void>;
}
