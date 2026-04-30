export interface QuadPoints {
    tl: { x: number; y: number };
    tr: { x: number; y: number };
    bl: { x: number; y: number };
    br: { x: number; y: number };
}

export interface DetectFromImageResult {
    quad: QuadPoints | null;
}

export interface DocumentDetectorPlugin {
    detectFromImage(options: { path: string }): Promise<DetectFromImageResult>;
}
