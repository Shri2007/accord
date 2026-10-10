// Imported as a URL so the build fingerprints it: a rebuilt catalog never collides with a cached one.
import catalogUrl from "./generated/catalog.json?url";

export type Price = {
  usd: number;
  ml: number | null;
  src: string;
  date: string;
  /** Sephora: product title as listed, and the price range across its sizes */
  title?: string;
  lo?: number;
  hi?: number;
  /** eBay: number of listings behind the median */
  n?: number;
};

export type BrandPrice = { lo: number; hi: number; n: number; src: string; date: string };

export type { Region, Story, Scheme } from "./mapdata";
import type { Eval, Region, Story } from "./mapdata";

export type Catalog = {
  meta: {
    count: number;
    source: string;
    scheme: string;
    k: number;
    eval: Eval;
  };
  tiers: string[];
  genders: string[];
  countries: string[];
  regions: Region[];
  story: Story;
  budgetBrands: string[];
  /** keyed by perfume id; only perfumes matched to a price dataset */
  prices: Record<string, { retail?: Price; street?: Price }>;
  brandPrices: Record<string, BrandPrice>;
  notes: string[];
  idf: number[];
  accords: string[];
  accordTier: number[];
  perfumes: {
    name: string[];
    brand: string[];
    year: (number | null)[];
    /** index into genders / countries */
    gender: number[];
    country: number[];
    rating: (number | null)[];
    votes: number[];
    perfumers: string[][];
    url: string[];
    top: number[][];
    middle: number[][];
    base: number[][];
    accords: number[][];
    tier: number[];
    weight: number[];
  };
};

/** Catalog plus the derived indexes the UI needs. Built once after load. */
export type Index = {
  c: Catalog;
  n: number;
  /** unique note ids per perfume, across all three layers */
  noteSet: Uint16Array[];
  /** L2 norm of each perfume's TF-IDF note vector, matching the pipeline */
  norm: Float32Array;
  /** "name brand" lowercased and stripped of accents, for search */
  haystack: string[];
  /** perfume ids per note id, for the note builder */
  postings: number[][];
  noteCount: number[];
  /** perfumes from houses known for affordable bottles */
  budget: Set<number>;
  /** neighbours computed so far, by perfume id */
  nnCache: Map<number, Neighbour[]>;
};

export type Neighbour = { id: number; sim: number };

export async function loadCatalog(): Promise<Index> {
  const res = await fetch(catalogUrl);
  if (!res.ok) throw new Error(`catalog.json: HTTP ${res.status}`);
  const c: Catalog = await res.json();
  const p = c.perfumes;
  const n = p.name.length;
  const noteSet: Uint16Array[] = new Array(n);
  const norm = new Float32Array(n);
  const postings: number[][] = c.notes.map(() => []);
  for (let i = 0; i < n; i++) {
    const s = Array.from(new Set([...p.top[i], ...p.middle[i], ...p.base[i]]));
    noteSet[i] = Uint16Array.from(s);
    let sq = 0;
    for (const j of s) {
      sq += c.idf[j] * c.idf[j];
      postings[j].push(i);
    }
    norm[i] = Math.sqrt(sq) || 1;
  }
  const haystack = p.name.map((nm, i) => fold(`${nm} ${p.brand[i]}`));
  const budgetBrands = new Set(c.budgetBrands);
  const budget = new Set<number>();
  p.brand.forEach((b, i) => budgetBrands.has(b) && budget.add(i));
  return {
    c,
    n,
    noteSet,
    norm,
    haystack,
    postings,
    noteCount: postings.map((l) => l.length),
    budget,
    nnCache: new Map(),
  };
}

export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every query word must appear; whole-word and prefix hits rank above substrings, then popularity. */
export function search(ix: Index, q: string, limit = 12): number[] {
  const words = fold(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  const scored: [number, number][] = [];
  for (let i = 0; i < ix.n; i++) {
    const h = ix.haystack[i];
    let score = 0;
    let ok = true;
    for (const w of words) {
      const at = h.indexOf(w);
      if (at < 0) {
        ok = false;
        break;
      }
      score += at === 0 ? 3 : h[at - 1] === " " ? 2 : 1;
    }
    if (ok) scored.push([i, score * 1e7 + ix.c.perfumes.votes[i]]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, limit).map((s) => s[0]);
}

export type NoteHit = { id: number; score: number; matched: number[] };

/** Cosine between a query of liked notes (IDF-weighted, like the pipeline) and every perfume. */
export function byNotes(ix: Index, liked: number[], limit = 24): NoteHit[] {
  if (!liked.length) return [];
  const idf = ix.c.idf;
  const qnorm = Math.sqrt(liked.reduce((s, j) => s + idf[j] * idf[j], 0));
  const dot = new Map<number, number>();
  for (const j of liked) for (const i of ix.postings[j]) dot.set(i, (dot.get(i) ?? 0) + idf[j] * idf[j]);
  const hits: NoteHit[] = [];
  for (const [i, d] of dot) hits.push({ id: i, score: d / (qnorm * ix.norm[i]), matched: [] });
  hits.sort((a, b) => b.score - a.score || ix.c.perfumes.votes[b.id] - ix.c.perfumes.votes[a.id]);
  const top = hits.slice(0, limit);
  const want = new Set(liked);
  for (const h of top) h.matched = Array.from(ix.noteSet[h.id]).filter((j) => want.has(j));
  return top;
}

/** Exact top-k by cosine over TF-IDF note vectors, the same ranking the pipeline benchmarks.
 *  Only perfumes sharing a note can score above zero, so walking those notes' postings is a
 *  few milliseconds rather than a scan of the catalog. */
export function neighbours(ix: Index, i: number, k = 10): Neighbour[] {
  const hit = ix.nnCache.get(i);
  if (hit) return hit;
  const idf = ix.c.idf;
  const dot = new Map<number, number>();
  for (const j of ix.noteSet[i]) {
    const w = idf[j] * idf[j];
    for (const o of ix.postings[j]) if (o !== i) dot.set(o, (dot.get(o) ?? 0) + w);
  }
  const votes = ix.c.perfumes.votes;
  const out = Array.from(dot, ([id, d]) => ({ id, sim: d / (ix.norm[i] * ix.norm[id]) }))
    .sort((a, b) => b.sim - a.sim || votes[b.id] - votes[a.id])
    .slice(0, k);
  ix.nnCache.set(i, out);
  return out;
}

export function fragranticaUrl(ix: Index, i: number): string {
  return `https://www.fragrantica.com/perfume/${ix.c.perfumes.url[i]}.html`;
}

/** Cosine similarity of two perfumes' TF-IDF note vectors, same as the pipeline's neighbours. */
export function similarity(ix: Index, a: number, b: number): number {
  const idf = ix.c.idf;
  let dot = 0;
  const s = new Set(ix.noteSet[a]);
  for (const j of ix.noteSet[b]) if (s.has(j)) dot += idf[j] * idf[j];
  return dot / (ix.norm[a] * ix.norm[b]);
}

/** Closest perfume from an affordable house, if one is close enough to be worth trying. */
export function budgetAlternative(ix: Index, i: number): { id: number; sim: number } | null {
  if (ix.budget.has(i)) return null;
  let best: { id: number; sim: number } | null = null;
  const votes = ix.c.perfumes.votes;
  for (const j of ix.budget) {
    const sim = similarity(ix, i, j);
    if (sim < 0.6) continue;
    // Near-ties go to the better-known bottle, which is easier to find and sample.
    if (!best || sim > best.sim + 0.01 || (sim > best.sim - 0.01 && votes[j] > votes[best.id])) best = { id: j, sim };
  }
  return best;
}

export type Reason = { tone: "good" | "bad" | "info"; text: string };
export type Verdict = { level: "safe" | "sample" | "smell"; headline: string; reasons: Reason[] };

const PRIOR_VOTES = 200;
const PRIOR_MEAN = 3.96; // catalog-wide mean rating

/** A rule of thumb for blind buying: crowd rating (shrunk toward the mean when few people
 *  voted), how divisive the scent family tends to be, and how close it is to the user's shelf. */
export function blindBuy(ix: Index, i: number, owned: Set<number>): Verdict {
  const P = ix.c.perfumes;
  const reasons: Reason[] = [];
  let points = 0;
  const r = P.rating[i];
  const v = P.votes[i];
  if (r == null) {
    reasons.push({ tone: "bad", text: "Nobody has rated it yet." });
    points--;
  } else {
    const shrunk = (v * r + PRIOR_VOTES * PRIOR_MEAN) / (v + PRIOR_VOTES);
    if (v < 100) {
      reasons.push({ tone: "bad", text: `Only ${v} people have rated it, so the score is shaky.` });
      points--;
    }
    if (shrunk >= 4.15) {
      reasons.push({ tone: "good", text: `Well liked: ${r.toFixed(1)} out of 5 from ${v.toLocaleString()} people.` });
      points++;
    } else if (shrunk < 3.8) {
      reasons.push({ tone: "bad", text: `Mixed reviews: ${r.toFixed(1)} out of 5.` });
      points--;
    } else if (v >= 100) {
      reasons.push({ tone: "info", text: `Decent reviews: ${r.toFixed(1)} out of 5 from ${v.toLocaleString()} people.` });
    }
  }
  const tier = P.tier[i];
  if (tier === 5) {
    reasons.push({ tone: "bad", text: "Musky, leathery and oud scents tend to split people. Smell it on skin first." });
    points--;
  } else if (tier <= 1) {
    reasons.push({ tone: "good", text: "Fresh, light scents tend to be the easiest to like." });
    points++;
  }
  const shelf = Array.from(owned).filter((j) => j !== i);
  if (shelf.length) {
    let best = shelf[0];
    let bs = -1;
    for (const j of shelf) {
      const s = similarity(ix, i, j);
      if (s > bs) [best, bs] = [j, s];
    }
    const pct = Math.round(bs * 100);
    if (bs >= 0.5) {
      reasons.push({ tone: "good", text: `Close to ${P.name[best]}, which you own (${pct}% alike).` });
      points++;
    } else if (bs < 0.2) {
      reasons.push({ tone: "bad", text: "Not much like anything on your shelf." });
      points--;
    } else {
      reasons.push({ tone: "info", text: `A little like ${P.name[best]} on your shelf (${pct}% alike).` });
    }
  } else {
    reasons.push({ tone: "info", text: "Tap “I own this” on bottles you have, and this check will compare against them." });
  }
  if (points >= 2) return { level: "safe", headline: "Fairly safe to blind buy", reasons };
  if (points <= -1) return { level: "smell", headline: "Smell it before you buy", reasons };
  return { level: "sample", headline: "Try a sample first", reasons };
}

export type ShopLink = { label: string; url: string; note: string };

/** Live searches on retailers and sample sites. Accord has no price or stock data of its own. */
export function shopLinks(ix: Index, i: number): { samples: ShopLink[]; bottles: ShopLink[] } {
  const P = ix.c.perfumes;
  const q = encodeURIComponent(`${P.brand[i]} ${P.name[i]}`);
  return {
    samples: [
      { label: "MicroPerfumes", url: `https://www.microperfumes.com/search?q=${q}`, note: "decants from 1 ml" },
      { label: "DecantX", url: `https://www.decantx.com/search?q=${q}`, note: "decants" },
      { label: "ScentSplit", url: `https://scentsplit.com/search?q=${q}`, note: "decants" },
      { label: "Surrender to Chance", url: `https://www.surrendertochance.com/?s=${q}&post_type=product`, note: "niche samples" },
      { label: "r/fragranceswap", url: `https://www.reddit.com/r/fragranceswap/search/?q=${q}&restrict_sr=1`, note: "partials from people" },
    ],
    bottles: [
      { label: "Compare prices", url: `https://www.google.com/search?tbm=shop&q=${q}`, note: "Google Shopping" },
      { label: "Amazon", url: `https://www.amazon.com/s?k=${q}`, note: "" },
      { label: "eBay", url: `https://www.ebay.com/sch/i.html?_nkw=${q}`, note: "often cheapest, check sellers" },
    ],
  };
}

export function priceOf(ix: Index, i: number): { retail?: Price; street?: Price } {
  return ix.c.prices[i] ?? {};
}

export function perMl(p: Price | undefined): number | null {
  return p && p.ml ? p.usd / p.ml : null;
}

export type Band = { sym: string; label: string; perMl: number; basis: Price };

/** Price tier from cost per ml, preferring the retail list price over eBay asking prices. */
export function priceBand(ix: Index, i: number): Band | null {
  const { retail, street } = priceOf(ix, i);
  const basis = retail?.ml ? retail : street?.ml ? street : null;
  if (!basis) return null;
  const pm = basis.usd / basis.ml!;
  const [sym, label] =
    pm < 0.5 ? ["$", "budget"] : pm < 1.2 ? ["$$", "mid-range"] : pm < 2.5 ? ["$$$", "pricey"] : ["$$$$", "luxury"];
  return { sym, label, perMl: pm, basis };
}

export function usd(x: number): string {
  return x >= 100 ? `$${Math.round(x)}` : `$${x.toFixed(x % 1 ? 2 : 0)}`;
}

/** "100 ml (3.4 oz)" — US shoppers think in ounces, labels print both. */
export function size(ml: number): string {
  return `${ml} ml (${(ml / 29.5735).toFixed(1)} oz)`;
}

export function sharedNotes(ix: Index, a: number, b: number): number[] {
  const s = new Set(ix.noteSet[a]);
  return Array.from(ix.noteSet[b]).filter((j) => s.has(j));
}

export function genderLabel(ix: Index, i: number): string {
  const g = ix.c.genders[ix.c.perfumes.gender[i]];
  return g === "men" ? "Masculine" : g === "women" ? "Feminine" : "Unisex";
}

const OWNED_KEY = "accord:owned";
// Keys from the app's earlier names, read once so saved shelves carry over.
const OLD_OWNED_KEYS = ["nosemap:owned", "drydown:owned"];

export function loadOwned(): Set<string> {
  try {
    // Older saves kept the ".html" suffix that catalog URLs no longer carry.
    const saved: string[] = JSON.parse([OWNED_KEY, ...OLD_OWNED_KEYS].map((k) => localStorage.getItem(k)).find((v) => v != null) ?? "[]");
    return new Set(saved.map((u) => u.replace(/\.html$/, "")));
  } catch {
    return new Set();
  }
}

export function saveOwned(s: Set<string>) {
  try {
    localStorage.setItem(OWNED_KEY, JSON.stringify(Array.from(s)));
  } catch {
    /* private mode: owned pins just won't persist */
  }
}
