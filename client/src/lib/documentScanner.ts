import { registerPlugin } from "@capacitor/core";

export interface ScannedPage {
  fileUri: string;
  width: number;
  height: number;
}

export interface ScanDocumentResult {
  pages: ScannedPage[];
  cancelled: boolean;
}

export interface DocumentScannerPlugin {
  scanDocument(): Promise<ScanDocumentResult>;
}

export const DocumentScanner = registerPlugin<DocumentScannerPlugin>("DocumentScanner");
