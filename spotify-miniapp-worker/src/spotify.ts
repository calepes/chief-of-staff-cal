// Token cache: avoid hitting auth worker on every request.
// Spotify tokens last 60min; we cache for 50min.
// Note: cache is best-effort — Workers may cold-start new isolates at any time.
let cachedToken: string | null = null;
let tokenExpiresAt = 0;
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes

export async function getToken(authService: Fetcher): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await authService.fetch('https://auth/token');
  if (!res.ok) {
    throw new Error(`Auth worker error: ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  return cachedToken;
}

const SPOTIFY_API = 'https://api.spotify.com/v1';

export async function spotifyFetch(
  authService: Fetcher,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const token = await getToken(authService);

  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${SPOTIFY_API}${path}`, init);

  // If 401, token may be stale — clear cache and retry once
  if (res.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
    const freshToken = await getToken(authService);
    const retryInit: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${freshToken}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) retryInit.body = JSON.stringify(body);
    const retryRes = await fetch(`${SPOTIFY_API}${path}`, retryInit);
    const retryText = await retryRes.text();
    return new Response(retryText || null, {
      status: retryRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Pass through Spotify's response (status, body)
  const text = await res.text();
  return new Response(text || null, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
