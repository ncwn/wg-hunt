import type { LatLng } from "./distance.js";
import { PLZ_CENTRES } from "./plz-centres.js";

let centres: Map<string, LatLng> | undefined;

function load(): Map<string, LatLng> {
  if (centres === undefined) {
    centres = new Map();
    for (const line of PLZ_CENTRES.split("\n")) {
      const [plz, lat, lng] = line.split(" ");
      if (plz !== undefined && lat !== undefined && lng !== undefined) {
        centres.set(plz, { lat: Number(lat), lng: Number(lng) });
      }
    }
  }
  return centres;
}

export function plzCentre(plz: string): LatLng | null {
  return load().get(plz) ?? null;
}
