export const API_BASE_URL = "/api/transactions/";
export const CONFIG_URL = "/api/config";

// Generic helper to perform JSON fetches against the backend API.
// This keeps all backend-specific details in one place so we can later
// swap it out for a local-first or cloud-aware implementation.
export async function fetchJson<T = any>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const text = await res.text();
    console.error("API error", res.url, res.status, res.statusText, text.slice(0, 200));
    throw new Error("API request failed");
  }
  return res.json() as Promise<T>;
}
