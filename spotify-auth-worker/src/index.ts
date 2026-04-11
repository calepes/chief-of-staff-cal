interface Env {
  SPOTIFY_TOKENS: KVNamespace
  SPOTIFY_CLIENT_ID: string
  SPOTIFY_CLIENT_SECRET: string
  SPOTIFY_REDIRECT_URI: string
}

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize'
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token'
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/login') {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: env.SPOTIFY_CLIENT_ID,
        scope: SCOPES,
        redirect_uri: env.SPOTIFY_REDIRECT_URI,
        state: crypto.randomUUID(),
      })
      return Response.redirect(`${SPOTIFY_AUTH_URL}?${params}`)
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code')
      if (!code) return new Response('Missing code', { status: 400 })

      const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: env.SPOTIFY_REDIRECT_URI,
        }),
      })

      const data = await res.json() as any
      if (data.error) return new Response(`Error: ${data.error_description ?? data.error}`, { status: 400 })

      await env.SPOTIFY_TOKENS.put('access_token', data.access_token, { expirationTtl: data.expires_in })
      await env.SPOTIFY_TOKENS.put('refresh_token', data.refresh_token)

      return new Response('Spotify connected! You can close this tab.')
    }

    if (url.pathname === '/token') {
      let token = await env.SPOTIFY_TOKENS.get('access_token')
      if (!token) {
        const refresh = await env.SPOTIFY_TOKENS.get('refresh_token')
        if (!refresh) return new Response('Not authenticated. Visit /login first.', { status: 401 })

        const res = await fetch(SPOTIFY_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refresh,
          }),
        })

        const data = await res.json() as any
        if (data.error) return new Response(`Refresh failed: ${data.error}`, { status: 401 })

        token = data.access_token
        await env.SPOTIFY_TOKENS.put('access_token', token!, { expirationTtl: data.expires_in })
        if (data.refresh_token) {
          await env.SPOTIFY_TOKENS.put('refresh_token', data.refresh_token)
        }
      }

      return new Response(JSON.stringify({ access_token: token }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response('Spotify Auth Worker. Visit /login to authenticate.', { status: 404 })
  },
}
