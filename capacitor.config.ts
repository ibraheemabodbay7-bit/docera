import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor configuration for Docera.
 *
 * Production build (App Store / Play Store):
 *   npm run build && npx cap sync
 *   (CAPACITOR_SERVER_URL must NOT be set — app is fully bundled)
 *
 * Live-reload dev build (test against a running server without rebuilding):
 *   CAPACITOR_SERVER_URL=http://192.168.x.x:5000 npx cap run ios
 *   (Your dev machine's LAN IP + the Express port)
 */
const config: CapacitorConfig = {
  appId: "com.docera.app",
  appName: "Docera",
  webDir: "dist/public",

  server: {
    androidScheme: "https",
    cleartext: true,
    ...(process.env.CAPACITOR_SERVER_URL
      ? { url: process.env.CAPACITOR_SERVER_URL }
      : {}),
  },

  ios: {
    contentInset: "never",
    limitsNavigationsToAppBoundDomains: false,
    backgroundColor: '#000000',
  },

  android: {
    allowMixedContent: true,
  },

  plugins: {
    Camera: {
      presentationStyle: "fullscreen",
    },
    // Permissions plugin — ensures iOS camera/photo-library prompts appear
    Permissions: {},
  },

};

export default config;
