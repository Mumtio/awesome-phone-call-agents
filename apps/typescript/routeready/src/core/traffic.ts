import type { GeoPoint } from "./types.js";

/** Driving times between points, from a traffic provider. Rows are origins, columns destinations. */
export interface TrafficMatrix {
  seconds: number[][];
  meters: number[][];
  /** Seconds of each trip caused by traffic, where the provider reports it. */
  delaySeconds: number[][];
}

export interface TrafficProvider {
  readonly name: string;
  matrix(origins: GeoPoint[], destinations: GeoPoint[]): Promise<TrafficMatrix>;
}

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface TomTomCell {
  originIndex: number;
  destinationIndex: number;
  routeSummary?: { lengthInMeters: number; travelTimeInSeconds: number; trafficDelayInSeconds?: number };
  detailedError?: { code?: string; message?: string };
}

/**
 * Live-traffic driving times from TomTom's synchronous Matrix Routing v2 API.
 * The API key stays on the server and is only ever sent to api.tomtom.com.
 */
export class TomTomTraffic implements TrafficProvider {
  readonly name = "TomTom";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    // Usually about a second, but a first request can take close to ten.
    private readonly timeoutMs = 20_000,
  ) {}

  async matrix(origins: GeoPoint[], destinations: GeoPoint[]): Promise<TrafficMatrix> {
    const point = (p: GeoPoint) => ({ point: { latitude: p.lat, longitude: p.lng } });
    const response = await this.fetchImpl(`https://api.tomtom.com/routing/matrix/2?key=${encodeURIComponent(this.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origins: origins.map(point),
        destinations: destinations.map(point),
        options: { departAt: "now", traffic: "live", travelMode: "car", routeType: "fastest" },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // The URL carries the key, so errors never repeat it.
    if (!response.ok) throw new Error(`TomTom traffic request failed (${response.status})`);
    const body = (await response.json()) as { data?: TomTomCell[] };
    if (!Array.isArray(body.data)) throw new Error("TomTom traffic response had no data");

    const grid = () => origins.map(() => destinations.map(() => Number.NaN));
    const matrix: TrafficMatrix = { seconds: grid(), meters: grid(), delaySeconds: grid() };
    for (const cell of body.data) {
      const summary = cell.routeSummary;
      if (!summary || !matrix.seconds[cell.originIndex] || cell.destinationIndex >= destinations.length) continue;
      matrix.seconds[cell.originIndex][cell.destinationIndex] = summary.travelTimeInSeconds;
      matrix.meters[cell.originIndex][cell.destinationIndex] = summary.lengthInMeters;
      matrix.delaySeconds[cell.originIndex][cell.destinationIndex] = summary.trafficDelayInSeconds ?? 0;
    }
    origins.forEach((origin, i) =>
      destinations.forEach((destination, j) => {
        if (origin.id === destination.id) {
          matrix.seconds[i][j] = 0;
          matrix.meters[i][j] = 0;
          matrix.delaySeconds[i][j] = 0;
        }
      }),
    );
    if (matrix.seconds.some((row) => row.some((value) => !Number.isFinite(value)))) {
      throw new Error("TomTom traffic response was missing some routes");
    }
    return matrix;
  }
}
