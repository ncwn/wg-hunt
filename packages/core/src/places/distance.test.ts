import { describe, expect, it } from "vitest";
import { haversineKm } from "./distance.js";

describe("haversine distance", () => {
  it("is zero between a point and itself", () => {
    expect(haversineKm({ lat: 52.52, lng: 13.405 }, { lat: 52.52, lng: 13.405 })).toBe(0);
  });

  it("is about 111.2 km for one degree of latitude", () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 1);
  });

  it("matches the known distance from London to Paris", () => {
    const london = { lat: 51.5074, lng: -0.1278 };
    const paris = { lat: 48.8566, lng: 2.3522 };
    expect(haversineKm(london, paris)).toBeCloseTo(343.6, 0);
  });

  it("is symmetric", () => {
    const berlin = { lat: 52.52, lng: 13.405 };
    const munich = { lat: 48.1351, lng: 11.582 };
    expect(haversineKm(berlin, munich)).toBeCloseTo(haversineKm(munich, berlin), 9);
    expect(haversineKm(berlin, munich)).toBeCloseTo(504, -1);
  });

  it("goes the short way round the date line", () => {
    expect(haversineKm({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 })).toBeCloseTo(111.19, 1);
  });
});
