import { handleApi } from './api';
import { getAppHtml } from './app';

export interface Env {
  SPOTIFY_AUTH_WORKER: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(getAppHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env.SPOTIFY_AUTH_WORKER);
    }

    return new Response('Not found', { status: 404 });
  },
};
