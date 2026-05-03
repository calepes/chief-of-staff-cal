export interface PlaceResult {
  id: string;
  name: string;
  formattedAddress?: string;
  googleMapsUri?: string;
  location: { lat: number; lng: number };
}

export interface TravelTimeResult {
  durationMin: number;
  distanceKm: number;
}

export interface MapsDeps {
  apiKey: string;
  homePin?: string; // "lat,lng"
}

export async function searchPlaces(query: string, deps: MapsDeps): Promise<PlaceResult[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": deps.apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.googleMapsUri,places.location",
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 5, languageCode: "es" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`places search failed: ${res.status}`);
  const data = (await res.json()) as {
    places?: Array<{
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      googleMapsUri?: string;
      location?: { latitude: number; longitude: number };
    }>;
  };
  return (data.places ?? []).map((p) => ({
    id: p.id,
    name: p.displayName?.text ?? "",
    formattedAddress: p.formattedAddress,
    googleMapsUri: p.googleMapsUri,
    location: { lat: p.location?.latitude ?? 0, lng: p.location?.longitude ?? 0 },
  }));
}

export async function travelTime(
  destLatLng: string,
  deps: MapsDeps,
  originLatLng?: string,
): Promise<TravelTimeResult> {
  const origin = originLatLng ?? deps.homePin;
  if (!origin) throw new Error("travelTime: no origin (set FAMILY_HOME_PIN or pass origin)");
  const [oLatStr, oLngStr] = origin.split(",");
  const [dLatStr, dLngStr] = destLatLng.split(",");
  const oLat = parseFloat(oLatStr ?? "");
  const oLng = parseFloat(oLngStr ?? "");
  const dLat = parseFloat(dLatStr ?? "");
  const dLng = parseFloat(dLngStr ?? "");
  if ([oLat, oLng, dLat, dLng].some((n) => Number.isNaN(n))) {
    throw new Error("travelTime: invalid lat/lng");
  }

  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": deps.apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: oLat, longitude: oLng } } },
      destination: { location: { latLng: { latitude: dLat, longitude: dLng } } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      languageCode: "es",
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`routes failed: ${res.status}`);
  const data = (await res.json()) as {
    routes?: Array<{ duration?: string; distanceMeters?: number }>;
  };
  const route = data.routes?.[0];
  if (!route) throw new Error("routes: no route returned");
  // duration comes as "1234s"
  const seconds = parseInt(String(route.duration ?? "0").replace("s", ""), 10);
  return {
    durationMin: Math.round(seconds / 60),
    distanceKm: Math.round((route.distanceMeters ?? 0) / 100) / 10,
  };
}
