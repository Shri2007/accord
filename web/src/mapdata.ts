// First-paint data: every dot's position (both layouts), shade and popularity, plus labels and
// the tour's measurements. Small enough to arrive well before the full catalog.
import mapBinUrl from "./generated/map.bin?url";
import mapJsonUrl from "./generated/map.json?url";

export type Region = {
  level: 0 | 1 | 2;
  label: string;
  x: number;
  y: number;
  size: number;
  example: number;
  exampleName: string;
};

export type Story = {
  notes: Record<string, { n: number; near: number; base: number }>;
  saffronWithOud: number;
  saffronOverall: number;
  weightLocal: number;
  weightGlobalR2: number;
  clone: { a: number; b: number; aName: string; bName: string; bBrand: string; sim: number };
  axes: {
    floral: number;
    woody: number;
    byWeight: Record<"light" | "mid" | "heavy", Slice>;
    byGender: Record<"men" | "women" | "unisex", Slice>;
    byEra: Record<"1980-1999" | "2016-2024", Slice>;
  };
};

/** Share of a group of perfumes leaning floral or woody on the axes view, and its mean weight. */
export type Slice = { n: number; floral: number; woody: number; weight: number };

export type Scheme = { accord_p_at_10: number; tier_p_at_10: number };
export type Eval = { accord_chance: number; tier_chance: number; schemes: Record<string, Scheme>; shipped: string };

export type MapData = {
  n: number;
  tiers: string[];
  regions: Region[];
  /** most-rated perfumes, [id, name], for map labels */
  famous: [number, string][];
  story: Story;
  eval: Eval;
  /** islands layout (UMAP) */
  x: Float32Array;
  y: Float32Array;
  /** axes layout: light→heavy weight, woody→floral */
  ax: Float32Array;
  ay: Float32Array;
  tier: Uint8Array;
  /** dot size multiplier from how many people rated it */
  grow: Float32Array;
  /** draw order: least-rated first, so popular dots sit on top */
  order: Uint32Array;
  /** perfumes listing each tour note */
  sets: Record<string, number[]>;
};

type MapJson = Omit<MapData, "x" | "y" | "ax" | "ay" | "tier" | "grow" | "order" | "sets"> & {
  sets: Record<string, string>;
};

function unpackBits(b64: string, n: number): number[] {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (bytes[i >> 3] & (1 << (i & 7))) out.push(i);
  return out;
}

export async function loadMap(): Promise<MapData> {
  const [jr, br] = await Promise.all([fetch(mapJsonUrl), fetch(mapBinUrl)]);
  if (!jr.ok || !br.ok) throw new Error(`map data: HTTP ${jr.status}/${br.status}`);
  const [j, buf] = await Promise.all([jr.json() as Promise<MapJson>, br.arrayBuffer()]);
  const n = j.n;
  // map.bin layout: four little-endian uint16 columns (x, y, ax, ay), then uint8 tier, uint8 popularity.
  const u16 = new Uint16Array(buf, 0, n * 4);
  const col = (k: number) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = u16[k * n + i] / 65535;
    return out;
  };
  const tier = new Uint8Array(buf, n * 8, n);
  const pop = new Uint8Array(buf, n * 9, n);
  const grow = new Float32Array(n);
  // pop = 50 * log10(votes + 1)
  for (let i = 0; i < n; i++) grow[i] = Math.min(1.6, Math.max(0.7, 0.45 + 0.27 * (pop[i] / 50)));
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => pop[a] - pop[b]);
  const sets: Record<string, number[]> = {};
  for (const [note, b64] of Object.entries(j.sets)) sets[note] = unpackBits(b64, n);
  return { ...j, x: col(0), y: col(1), ax: col(2), ay: col(3), tier, grow, order, sets };
}
