import { registerPlugin } from "@capacitor/core";

export interface SharedFilesPlugin {
  getPendingFiles(): Promise<{ paths: string[] }>;
  clearPendingFiles(): Promise<void>;
}

export const SharedFiles = registerPlugin<SharedFilesPlugin>("SharedFiles");
