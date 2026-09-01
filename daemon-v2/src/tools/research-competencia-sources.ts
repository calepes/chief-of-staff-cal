import gplay from "google-play-scraper";

export interface IosAppInfo {
  version: string;
  rating: number | null;
  ratingCount: number | null;
  releaseNotes: string | null;
}

export interface AndroidAppInfo {
  version: string | null;
  rating: number | null;
  ratingCount: number | null;
  releaseNotes: string | null;
}

export function extractVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function fetchIosAppInfo(
  app: { trackId?: string; searchTerm?: string },
  fetchFn: typeof fetch = fetch,
): Promise<IosAppInfo | null> {
  const url = app.trackId
    ? `https://itunes.apple.com/lookup?id=${app.trackId}&country=bo`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(app.searchTerm ?? "")}&country=bo&entity=software&limit=1`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const r = data.results?.[0];
  if (!r) return null;
  return {
    version: String(r.version ?? ""),
    rating: typeof r.averageUserRating === "number" ? r.averageUserRating : null,
    ratingCount: typeof r.userRatingCount === "number" ? r.userRatingCount : null,
    releaseNotes: typeof r.releaseNotes === "string" ? r.releaseNotes : null,
  };
}

export async function fetchAndroidAppInfo(
  packageName: string,
  gplayFn: typeof gplay.app = gplay.app,
): Promise<AndroidAppInfo | null> {
  try {
    const r = (await gplayFn({ appId: packageName })) as {
      version?: string; score?: number; ratings?: number; recentChanges?: string;
    };
    return {
      version: r.version ?? null,
      rating: typeof r.score === "number" ? r.score : null,
      ratingCount: typeof r.ratings === "number" ? r.ratings : null,
      releaseNotes: r.recentChanges ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchSiteText(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const html = await res.text();
    return extractVisibleText(html).slice(0, 5000);
  } catch {
    return null;
  }
}
