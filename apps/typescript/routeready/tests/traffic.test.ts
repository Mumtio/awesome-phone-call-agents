import { describe, expect, it } from "vitest";
import type { CallPort } from "../src/calle/ports.js";
import { TomTomTraffic, type TrafficMatrix, type TrafficProvider } from "../src/core/traffic.js";
import type { GeoPoint } from "../src/core/types.js";
import { FieldSession, TRAFFIC_RETRY_MS, TRAFFIC_STOPS_REFRESH_MS, type FieldSetup, type FieldStop } from "../src/field/session.js";

// Live traffic for visitor routes, against a fake TomTom API: no network, no key, no calls.

const KM = 0.009;
const idle: CallPort = { mode: "live", start: async () => ({ callId: "x" }), poll: async () => ({ lines: [], final: null }) };

function stop(id: string, kmNorth: number, kmEast = 0): FieldStop {
  return {
    id,
    order: `#T${id}`,
    customer: `Customer ${id}`,
    label: "",
    phone: `+1415555010${id.slice(1)}`,
    region: "US",
    cash: "",
    lat: 40.7 + kmNorth * KM,
    lng: -74 + kmEast * KM,
    codAmount: null,
    serviceMinutes: 3,
    windowEnd: null,
    firstTime: false,
    gated: false,
  };
}

/** A traffic provider that answers from a function of (origin, destination) and counts requests. */
function fakeTraffic(minutes: (from: GeoPoint, to: GeoPoint) => number) {
  const requests: string[] = [];
  let failing = false;
  const provider: TrafficProvider = {
    name: "FakeTraffic",
    async matrix(origins, destinations): Promise<TrafficMatrix> {
      requests.push(`${origins.length}x${destinations.length}`);
      if (failing) throw new Error("traffic service down");
      const grid = (value: (o: GeoPoint, d: GeoPoint) => number) => origins.map((o) => destinations.map((d) => (o.id === d.id ? 0 : value(o, d))));
      return { seconds: grid((o, d) => minutes(o, d) * 60), meters: grid(() => 1000), delaySeconds: grid(() => 240) };
    },
  };
  return { provider, requests, fail: (value: boolean) => (failing = value) };
}

function route(stops: FieldStop[], traffic: TrafficProvider | null) {
  let now = Date.UTC(2026, 8, 14, 9, 0);
  const setup: FieldSetup = {
    merchant: "Test Shop",
    language: "English",
    callAheadMinutes: 5,
    speedKmh: 20,
    testCall: true,
    utcOffsetMinutes: 0,
    stops,
    rider: { lat: 40.7, lng: -74 },
    locationSource: "drag",
  };
  const session = new FieldSession("field-test", setup, idle, () => now, undefined, traffic);
  return { session, advance: (ms: number) => (now += ms) };
}

describe("TomTomTraffic", () => {
  it("asks for live traffic departing now and reads the matrix", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { originIndex: 0, destinationIndex: 0, routeSummary: { lengthInMeters: 1800, travelTimeInSeconds: 420, trafficDelayInSeconds: 90 } },
            { originIndex: 0, destinationIndex: 1, routeSummary: { lengthInMeters: 2500, travelTimeInSeconds: 660, trafficDelayInSeconds: 0 } },
          ],
        }),
      };
    };
    const traffic = new TomTomTraffic("secret-key", fetchImpl);
    const matrix = await traffic.matrix([{ id: "rider", lat: 40.7, lng: -74 }], [stop("s1", 2), stop("s2", 3)]);
    expect(calls[0].url).toBe("https://api.tomtom.com/routing/matrix/2?key=secret-key");
    expect(calls[0].body).toMatchObject({
      origins: [{ point: { latitude: 40.7, longitude: -74 } }],
      options: { departAt: "now", traffic: "live", travelMode: "car" },
    });
    expect(matrix).toEqual({ seconds: [[420, 660]], meters: [[1800, 2500]], delaySeconds: [[90, 0]] });
  });

  it("fails without repeating the key when the request or the data is bad", async () => {
    const refused = new TomTomTraffic("secret-key", async () => ({ ok: false, status: 403, json: async () => ({}) }));
    await expect(refused.matrix([stop("s1", 1)], [stop("s2", 2)])).rejects.toThrow(/403/);
    await expect(refused.matrix([stop("s1", 1)], [stop("s2", 2)])).rejects.not.toThrow(/secret-key/);
    const partial = new TomTomTraffic("secret-key", async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
    await expect(partial.matrix([stop("s1", 1)], [stop("s2", 2)])).rejects.toThrow(/missing/);
  });
});

describe("arrival times on a visitor route", () => {
  it("use live traffic once it arrives", async () => {
    const { provider } = fakeTraffic(() => 17);
    const { session } = route([stop("s1", 2)], provider);
    const estimated = session.etas().get("s1") ?? 0;
    expect(estimated).toBeLessThan(10);

    await session.refreshTraffic();
    expect(session.etas().get("s1")).toBeCloseTo(17, 5);
    expect(session.trafficStatus()).toMatchObject({ live: true, provider: "FakeTraffic", nextDelayMinutes: 4 });
  });

  it("scale the rider's live times as the rider moves between refreshes", async () => {
    const { provider } = fakeTraffic(() => 20);
    const { session } = route([stop("s1", 4)], provider);
    await session.refreshTraffic();
    session.moveRider(40.7 + 2 * KM, -74); // halfway, less than a refresh away in time
    expect(session.etas().get("s1")).toBeCloseTo(10, 0);
  });

  it("fall back to distance estimates when traffic fails, and retry later", async () => {
    const traffic = fakeTraffic(() => 17);
    const { session, advance } = route([stop("s1", 2), stop("s2", 3)], traffic.provider);
    traffic.fail(true);
    await session.refreshTraffic();
    expect(session.trafficStatus().live).toBe(false);
    expect(session.etas().get("s1")).toBeLessThan(10);
    expect(session.log.filter((entry) => entry.kind === "traffic")).toHaveLength(1);

    const before = traffic.requests.length;
    await session.refreshTraffic();
    expect(traffic.requests.length).toBe(before);

    traffic.fail(false);
    advance(TRAFFIC_RETRY_MS + 1);
    await session.refreshTraffic();
    expect(session.trafficStatus().live).toBe(true);
    expect((session.etas().get("s1") ?? 0) - session.now()).toBeCloseTo(17, 5);
  });

  it("refresh stop-to-stop traffic rarely and the rider's row when needed", async () => {
    const traffic = fakeTraffic(() => 8);
    const { session, advance } = route([stop("s1", 2), stop("s2", 3)], traffic.provider);
    await session.refreshTraffic();
    expect(traffic.requests).toEqual(["2x2", "1x2"]);

    await session.refreshTraffic();
    expect(traffic.requests).toHaveLength(2);

    session.moveRider(40.7 + 0.5 * KM, -74);
    await session.refreshTraffic();
    expect(traffic.requests).toEqual(["2x2", "1x2", "1x2"]);

    advance(TRAFFIC_STOPS_REFRESH_MS + 1);
    await session.refreshTraffic();
    expect(traffic.requests.slice(3)).toEqual(["2x2", "1x2"]);
  });

  it("re-plan the route when live traffic changes which stop is quicker", async () => {
    // By distance s1 is nearer, but traffic makes s1 slow and s2 quick.
    const traffic = fakeTraffic((from, to) => (to.id === "s1" ? 40 : from.id === "rider" ? 6 : 8));
    const { session } = route([stop("s1", 2), stop("s2", 3)], traffic.provider);
    expect(session.order).toEqual(["s1", "s2"]);
    await session.refreshTraffic(); // the order is re-planned on the first stop-to-stop traffic
    expect(session.order).toEqual(["s2", "s1"]);
  });

  it("stay on distance estimates with no traffic provider", async () => {
    const { session } = route([stop("s1", 2)], null);
    await session.refreshTraffic();
    expect(session.trafficStatus()).toMatchObject({ live: false, provider: null });
  });
});
