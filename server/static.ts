import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.includes("/assets/")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }));

  // Browser visitors get an iOS-only page; the app runs natively on iPhone
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Docera – iOS App</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a1628; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; text-align: center; padding: 24px; box-sizing: border-box; }
    .card { max-width: 400px; }
    .logo { font-size: 2.5rem; font-weight: 700; letter-spacing: -1px; margin-bottom: 8px; }
    .sub { font-size: 1.1rem; color: #8ea8d8; margin-bottom: 32px; }
    .badge { font-size: 1rem; color: #8ea8d8; }
    .legal { margin-top: 40px; font-size: 0.8rem; color: #4a6080; }
    .legal a { color: #4a6080; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Docera</div>
    <div class="sub">Professional document scanning for iPhone</div>
    <div class="badge">Coming soon to the App Store</div>
    <div class="legal"><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Use</a></div>
  </div>
</body>
</html>`);
  });
}
