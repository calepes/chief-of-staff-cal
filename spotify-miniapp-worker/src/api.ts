import { spotifyFetch } from './spotify';

export async function handleApi(
  request: Request,
  url: URL,
  authWorkerUrl: string
): Promise<Response> {
  const path = url.pathname.replace('/api', '');
  const cors = { 'Access-Control-Allow-Origin': '*' };

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  switch (path) {
    case '/now-playing':
      return spotifyFetch(authWorkerUrl, 'GET', '/me/player/currently-playing');

    case '/play':
      return spotifyFetch(authWorkerUrl, 'PUT', '/me/player/play');

    case '/pause':
      return spotifyFetch(authWorkerUrl, 'PUT', '/me/player/pause');

    case '/next':
      return spotifyFetch(authWorkerUrl, 'POST', '/me/player/next');

    case '/previous':
      return spotifyFetch(authWorkerUrl, 'POST', '/me/player/previous');

    case '/volume': {
      const percent = url.searchParams.get('percent') ?? '50';
      return spotifyFetch(
        authWorkerUrl,
        'PUT',
        `/me/player/volume?volume_percent=${encodeURIComponent(percent)}`
      );
    }

    case '/queue':
      return spotifyFetch(authWorkerUrl, 'GET', '/me/player/queue');

    case '/search': {
      const q = url.searchParams.get('q') ?? '';
      const type = url.searchParams.get('type') ?? 'track,artist,playlist';
      return spotifyFetch(
        authWorkerUrl,
        'GET',
        `/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&limit=10`
      );
    }

    case '/play-uri': {
      let body: { uri?: string; context_uri?: string; offset?: { uri?: string; position?: number } };
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const playBody: Record<string, unknown> = {};
      if (body.uri) playBody.uris = [body.uri];
      if (body.context_uri) playBody.context_uri = body.context_uri;
      if (body.offset) playBody.offset = body.offset;
      return spotifyFetch(authWorkerUrl, 'PUT', '/me/player/play', playBody);
    }

    default:
      return new Response(JSON.stringify({ error: 'Unknown API route' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
  }
}
