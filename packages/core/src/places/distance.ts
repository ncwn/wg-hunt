/** A point on Earth, in degrees. Location data: local database only, never in logs or errors. */
export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_KM = 6371.0088;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
