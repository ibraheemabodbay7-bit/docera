import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";

// Google OAuth client IDs (public — safe to commit)
export const GMAIL_OAUTH_CLIENT_ID_NATIVE = "787920130380-25us11cn9ekfe14fbkoj4dntqf6i7hlk.apps.googleusercontent.com";
export const GMAIL_OAUTH_CLIENT_ID_WEB = "787920130380-euura0so62q39iro5t4ukfqlsiu5tagd.apps.googleusercontent.com";

// Scopes Docera requests
export const GMAIL_OAUTH_SCOPES = "https://www.googleapis.com/auth/gmail.send";

// Redirect URI (matches what's registered in Google Cloud)
export const GMAIL_OAUTH_REDIRECT_URI = "com.docera.app:/oauth2callback";

export function buildGmailAuthUrl(): string {
  const clientId = Capacitor.isNativePlatform()
    ? GMAIL_OAUTH_CLIENT_ID_NATIVE
    : GMAIL_OAUTH_CLIENT_ID_WEB;
  return (
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${clientId}` +
    `&redirect_uri=${GMAIL_OAUTH_REDIRECT_URI}` +
    "&response_type=code" +
    `&scope=${GMAIL_OAUTH_SCOPES}` +
    "&access_type=offline" +
    "&prompt=consent"
  );
}

export async function startGmailConnection(): Promise<void> {
  const url = buildGmailAuthUrl();
  await Browser.open({ url });
}
