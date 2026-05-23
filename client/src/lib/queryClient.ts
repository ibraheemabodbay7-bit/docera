import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { Capacitor } from "@capacitor/core";

export const API_BASE = Capacitor.isNativePlatform()
  ? "https://docera-production.up.railway.app"
  : "";

function resolveUrl(url: string): string {
  return url.startsWith("/") && Capacitor.isNativePlatform()
    ? `${API_BASE}${url}`
    : url;
}

export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(resolveUrl(url), { credentials: "include", ...init });
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown,
): Promise<Response> {
  // Test if server is reachable first
  try {
    const testRes = await fetch(`${API_BASE}/api/health`, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors'
    });
    console.log('[network] Server reachable, status:', testRes.status);
  } catch (err) {
    console.error('[network] Server NOT reachable:', err);
  }

  const fullUrl = resolveUrl(url);
  console.log('[apiRequest] method:', method, 'fullUrl:', fullUrl, 'isNative:', Capacitor.isNativePlatform());
  let body: string | undefined;
  try {
    body = data ? JSON.stringify(data) : undefined;
    console.log('[apiRequest] body JSON.stringify succeeded, length:', body?.length);
  } catch (jsonErr) {
    console.log('[apiRequest] JSON.stringify failed:', jsonErr);
    throw jsonErr;
  }
  try {
    const res = await fetch(fullUrl, {
      method,
      mode: 'cors',
      headers: data ? { "Content-Type": "application/json" } : {},
      body,
      credentials: Capacitor.isNativePlatform() ? "omit" : "include",
    });
    console.log('[apiRequest] fetch succeeded, status:', res.status);
    await throwIfResNotOk(res);
    return res;
  } catch (fetchErr: unknown) {
    const e = fetchErr as Error & { code?: number; name?: string };
    console.log('[apiRequest] fetch threw:', JSON.stringify(fetchErr), e?.message, e?.name, e?.code, e?.stack);
    throw fetchErr;
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const path = queryKey.join("/") as string;
    const res = await fetch(resolveUrl(path), { credentials: "include" });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
