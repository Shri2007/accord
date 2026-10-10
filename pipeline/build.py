"""Build the Nose Map catalog from the Kaggle Fragrantica dataset.

Reads data/raw/fra_cleaned.csv (structured pyramids) and data/raw/fra_perfumes.csv
(display names and the longer accord lists), builds TF-IDF note vectors over the
pyramid, benchmarks three weighting schemes (see evaluate), computes a UMAP projection and
an axes layout, attaches dated price snapshots (see prices.py), and writes
web/src/generated/{map.bin,map.json,catalog.json} plus pipeline/eval.json.

    .venv/bin/python pipeline/build.py
"""

import ast
import json
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.decomposition import TruncatedSVD
from sklearn.preprocessing import normalize

import og_image
from prices import attach

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "src" / "generated"

K_NEIGHBOURS = 10
SEED = 42

# Tried and benchmarked in evaluate(): weighting base notes up (they are what survives the
# drydown) made neighbours worse at predicting the crowd-voted accord, so the shipped vectors
# treat every layer equally. Kept so the comparison stays reproducible.
LAYER_WEIGHTS = {"top": 0.6, "middle": 0.8, "base": 1.0}
SHIPPED_SCHEME = "tfidf"

# Evaporation tiers, light to heavy. A flight should walk these in order, because
# heavy molecules linger in the nose and contaminate whatever comes after them.
TIERS = [
    ("Citrus & aromatic", ["citrus", "aromatic", "lavender", "herbal", "anis", "camphor", "fresh spicy"]),
    ("Green, fresh & fruity", ["green", "fresh", "aquatic", "marine", "ozonic", "aldehydic", "metallic",
                               "mineral", "salty", "soapy", "fruity", "tropical", "cherry", "sour", "bitter",
                               "champagne", "vodka", "wine", "alcohol", "coca-cola"]),
    ("Floral", ["floral", "white floral", "yellow floral", "rose", "violet", "iris", "tuberose", "powdery"]),
    ("Woody & earthy", ["woody", "earthy", "patchouli", "mossy", "conifer", "smoky", "terpenic", "sand", "clay",
                        "cannabis", "asphault", "vinyl", "plastic", "rubber", "hot iron", "industrial glue",
                        "oily"]),
    ("Amber & gourmand", ["amber", "sweet", "vanilla", "balsamic", "warm spicy", "soft spicy", "spicy",
                          "cinnamon", "caramel", "honey", "almond", "coconut", "lactonic", "cacao", "coffee",
                          "chocolate", "nutty", "rum", "whiskey", "tobacco", "beeswax", "savory", "oriental",
                          "gourmand"]),
    ("Animalic, musk & oud", ["animalic", "musky", "leather", "oud"]),
]
ACCORD_TIER = {a: i for i, (_, accords) in enumerate(TIERS) for a in accords}
DEFAULT_TIER = 3

GENDER_SUFFIXES = ["for women and men", "for women", "for men"]

# Houses widely known for affordable bottles, many of them "inspired by" designer and niche
# scents. Hand-picked and deliberately conservative: houses with expensive lines (Rasasi,
# Al Haramain, Ajmal) are left out. The app uses this to suggest a cheaper route to a smell.
BUDGET_HOUSES = [
    "Armaf", "Lattafa Perfumes", "Maison Alhambra", "Fragrance World", "Alexandria Fragrances", "Zara",
    "Afnan", "Ard Al Zaafaran", "Paris Corner", "Orientica", "Emper", "Reyane Tradition", "In The Box",
    "Sapil", "La Rive", "Cuba Paris", "Al Wataniah", "Oakcha", "Dossier", "Parfums Vintage", "Nabeel",
    "Asdaaf", "Avon", "Natura", "O Boticario", "Oriflame", "Bath & Body Works", "Jeanne Arthes",
    "Faberlic", "Yves Rocher", "Eudora",
]

# Fragrantica lists some pyramids with placeholder notes; give their regions plain names.
GENERIC_NOTES = {"citruses": "citrus", "woody notes": "woody", "woodsy notes": "woody", "fruity notes": "fruity",
                 "floral notes": "floral", "spicy notes": "spicy", "green notes": "green"}
SHORT_NOTE = {"agarwood (oud)": "oud", "lily-of-the-valley": "lily of the valley"}


def split_notes(s):
    """Split on commas that are not inside parentheses: 'arbutus (madrona, bearberry tree)' stays whole."""
    if not isinstance(s, str):
        return []
    parts, depth, cur = [], 0, []
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    out = []
    for p in parts:
        p = re.sub(r"\s+", " ", p).strip().lower()
        if p and p != "unknown" and p not in out:
            out.append(p)
    return out


def slug_title(slug):
    return " ".join(w[:1].upper() + w[1:] for w in str(slug).replace("-", " ").split())


def display_names(row):
    """fra_perfumes glues name, brand and gender together ('9am Dive Afnanfor women and men')."""
    brand = row["url_brand"].replace("-", " ") if isinstance(row["url_brand"], str) else slug_title(row["Brand"])
    name = row["Name"] if isinstance(row["Name"], str) else ""
    for suf in GENDER_SUFFIXES:
        if name.endswith(suf):
            name = name[: -len(suf)]
            break
    name = name.strip()
    # URL brands lose punctuation ("D-ORSAY" for "D’ORSAY"), so match the suffix on letters only
    # and keep the brand as the name spelled it.
    key = re.sub(r"[^a-z0-9]", "", brand.lower())
    for cut in range(len(name) - 1, 0, -1):
        if re.sub(r"[^a-z0-9]", "", name[cut:].lower()) == key and name[cut - 1] == " ":
            name, brand = name[:cut].strip(), name[cut:].strip()
            break
    if not name:
        name = slug_title(row["Perfume"])
    return name, brand


def evaporation_weight(accords):
    """Position-weighted mean tier (1 = lightest, 6 = heaviest) over the voted accords."""
    if not accords:
        return float(DEFAULT_TIER + 1)
    w = np.array([1.0 / (i + 1) for i in range(len(accords))])
    t = np.array([ACCORD_TIER.get(a, DEFAULT_TIER) + 1 for a in accords], dtype=float)
    return float((w * t).sum() / w.sum())


def fit_unit_square(c):
    """Scale to [0,1] on the 0.1-99.9 percentile box; squash the few far islands into a thin
    margin instead of letting them shrink everything else."""
    lo, hi = np.percentile(c, 0.1, axis=0), np.percentile(c, 99.9, axis=0)
    u = (c - lo) / (hi - lo)
    m = 0.03
    u = np.where(u > 1, 1 + m * np.tanh((u - 1) / m), u)
    u = np.where(u < 0, -m * np.tanh(-u / m), u)
    return (u + m) / (1 + 2 * m)


# Map labels come in three levels, like a printed map: broad scent families when zoomed out,
# ingredient neighbourhoods on top, and finer neighbourhoods once you zoom in.
REGION_LEVELS = [(0, 8, True), (1, 32, False), (2, 90, False)]


def label_regions(perfumes, notes, accords, k=32, accords_only=False, level=1):
    """Name the map's neighbourhoods. Cluster the 2-D layout, then label each cluster with
    the notes or accords most over-represented in it, plus its best-known perfume as an
    anchor a beginner will recognise. Clusters with no clear signature get no label."""
    from collections import Counter

    from sklearn.cluster import KMeans

    xy = np.c_[perfumes["x"], perfumes["y"]]
    n = len(xy)
    votes = np.asarray(perfumes["votes"])
    top3 = [set(a[:3]) for a in perfumes["accords"]]
    nsets = [set(t + m + b) for t, m, b in zip(perfumes["top"], perfumes["middle"], perfumes["base"])]
    g_acc = Counter(a for s in top3 for a in s)
    g_note = Counter(j for s in nsets for j in s)
    labels = KMeans(k, random_state=SEED, n_init=10).fit_predict(xy)
    regions = []
    for cl in range(k):
        idx = np.where(labels == cl)[0]
        terms = []
        for j, cnt in Counter(j for i in idx for j in nsets[i]).items():
            share, lift = cnt / len(idx), cnt / len(idx) / (g_note[j] / n)
            if not accords_only and share >= 0.35 and lift >= 2.2:
                name = notes[j]
                terms.append((share * lift, GENERIC_NOTES.get(name, SHORT_NOTE.get(name, name))))
        for a, cnt in Counter(a for i in idx for a in top3[i]).items():
            share, lift = cnt / len(idx), cnt / len(idx) / (g_acc[a] / n)
            if share >= (0.3 if accords_only else 0.35) and lift >= (1.3 if accords_only else 1.8):
                terms.append((share * lift * 0.5, accords[a]))  # notes are more specific; prefer them
        terms.sort(reverse=True)
        words = []
        for _, t in terms:
            if t not in words and not any(t in w or w in t for w in words):
                words.append(t)
        if not words:
            continue
        # Anchor the label at the medoid, not the mean, so it sits on dots rather than in a gap.
        centre = xy[idx].mean(axis=0)
        medoid = idx[np.argmin(((xy[idx] - centre) ** 2).sum(axis=1))]
        example = int(idx[np.argmax(votes[idx])])
        regions.append({
            "level": level,
            "label": (" & ".join(words[:2]) if accords_only else " · ".join(words[:2])),
            "x": round(float(xy[medoid, 0]), 4),
            "y": round(float(xy[medoid, 1]), 4),
            "size": int(len(idx)),
            "example": example,
        })
    return sorted(regions, key=lambda r: -r["size"])


# Notes the map tour talks about. The tour quotes these numbers, so they are measured here
# rather than written into the copy.
STORY_NOTES = ["peony", "mint", "tuberose", "agarwood (oud)", "lavender", "musk", "vanilla"]


def story_stats(perfumes, notes):
    """For each tour note: how many perfumes list it, and what share of a perfume's 20 nearest
    dots on the map also list it, against the catalog-wide share. Plus how strongly
    light/heavy weight clusters locally versus as one big gradient."""
    from sklearn.linear_model import LinearRegression
    from sklearn.neighbors import NearestNeighbors

    xy = np.c_[perfumes["x"], perfumes["y"]]
    near = NearestNeighbors(n_neighbors=21).fit(xy).kneighbors(xy, return_distance=False)[:, 1:]
    nsets = [set(t + m + b) for t, m, b in zip(perfumes["top"], perfumes["middle"], perfumes["base"])]
    out = {"notes": {}}
    for name in STORY_NOTES:
        j = notes.index(name)
        has = np.array([j in s for s in nsets])
        out["notes"][name] = {"n": int(has.sum()), "near": round(float(has[near[has]].mean()), 3),
                              "base": round(float(has.mean()), 3)}
    oud, saffron = notes.index("agarwood (oud)"), notes.index("saffron")
    has_oud = np.array([oud in s for s in nsets])
    has_saf = np.array([saffron in s for s in nsets])
    out["saffronWithOud"] = round(float(has_saf[has_oud].mean()), 3)
    out["saffronOverall"] = round(float(has_saf.mean()), 3)
    w = np.asarray(perfumes["weight"])
    out["weightLocal"] = round(float(np.corrcoef(w, w[near].mean(axis=1))[0, 1]), 3)
    out["weightGlobalR2"] = round(float(LinearRegression().fit(xy, w).score(xy, w)), 3)
    return out


# Second axis for the axes view: position-weighted accords, floral families up, woody down.
# It is nearly independent of the light-to-heavy weight on the other axis (r = -0.14), unlike
# fresh-vs-warm (r = -0.95), which would just repeat it.
FLORAL = {"floral", "white floral", "yellow floral", "rose", "violet", "iris", "tuberose", "powdery"}
WOODY = {"woody", "earthy", "patchouli", "mossy", "conifer", "smoky", "leather", "oud", "tobacco"}


def axes_coords(weights, accord_lists):
    """x = light-to-heavy weight (1-6), y = floral-minus-woody score, both scaled to [0,1].
    A small fixed jitter separates the many perfumes that share exact values."""
    rng = np.random.default_rng(SEED)
    x = (np.asarray(weights) - 1) / 5
    ys = []
    for acc in accord_lists:
        w = np.array([1 / (k + 1) for k in range(len(acc))]) if acc else np.ones(1)
        v = np.array([(a in FLORAL) - (a in WOODY) for a in acc]) if acc else np.zeros(1)
        ys.append((w * v).sum() / w.sum())
    y = 0.5 + 0.5 * np.clip(np.asarray(ys) / 0.8, -1, 1)
    x = np.clip(x + rng.uniform(-0.006, 0.006, len(x)), 0, 1)
    y = np.clip(y + rng.uniform(-0.006, 0.006, len(y)), 0, 1)
    return np.c_[x, y]


def clone_pair(df, X, name, brand):
    """The tour's clone example: a famous perfume and its closest match from another house
    (most-rated wins ties, since several clones can list identical notes)."""
    a = int(df.index[(df.name == name) & (df.brand == brand)][0])
    sims = (X[a] @ X.T).toarray().ravel()
    other = (df.brand != brand).to_numpy()
    best = sims[other].max()
    cands = np.where(other & (sims >= best - 1e-6))[0]
    b = int(max(cands, key=lambda i: df["Rating Count"].iat[i]))
    return {"a": a, "b": b, "aName": name, "bName": df.name.iat[b], "bBrand": df.brand.iat[b], "sim": round(float(best), 3)}


def bitset(ids, n):
    """Perfume ids as a base64 bitset (3 KB for the whole catalog), for tour highlights."""
    import base64

    bits = np.zeros(n, dtype=bool)
    bits[list(ids)] = True
    return base64.b64encode(np.packbits(bits, bitorder="little").tobytes()).decode()


def axes_stats(axes, weights, genders, years):
    """Numbers the explainer quotes about the axes view. 'Floral' and 'woody' mean the top and
    bottom thirds of the floral-woody axis (score beyond ±0.24, before jitter)."""
    w = np.asarray(weights)
    floral, woody = axes[:, 1] > 0.65, axes[:, 1] < 0.35
    share = lambda m: {"n": int(m.sum()), "floral": round(float(floral[m].mean()), 3),
                       "woody": round(float(woody[m].mean()), 3), "weight": round(float(w[m].mean()), 2)}
    g = np.asarray(genders)
    y = np.array([np.nan if v is None or pd.isna(v) else v for v in years], dtype=float)
    return {
        "floral": round(float(floral.mean()), 3),
        "woody": round(float(woody.mean()), 3),
        "byWeight": {"light": share(w < 2.5), "mid": share((w >= 2.5) & (w < 4)), "heavy": share(w >= 4)},
        "byGender": {k: share(g == k) for k in ("men", "women", "unisex")},
        "byEra": {"1980-1999": share((y >= 1980) & (y < 2000)), "2016-2024": share(y >= 2016)},
    }


FAMOUS = 400


def write_map(catalog, coords, axes):
    """First-paint files: map.bin holds every dot (positions in both layouts, shade, popularity)
    in 10 bytes a perfume; map.json holds labels and the tour numbers. Together they are a small
    fraction of the catalog, so the map draws before the full details arrive."""
    P = catalog["perfumes"]
    q = lambda a: np.round(np.clip(a, 0, 1) * 65535).astype("<u2")
    pop = np.clip(np.round(np.log10(np.asarray(P["votes"]) + 1) * 50), 0, 255).astype("u1")
    with open(OUT / "map.bin", "wb") as f:
        for arr in (q(coords[:, 0]), q(coords[:, 1]), q(axes[:, 0]), q(axes[:, 1])):
            f.write(arr.tobytes())
        f.write(np.asarray(P["tier"], dtype="u1").tobytes())
        f.write(pop.tobytes())
    famous = sorted(range(len(P["votes"])), key=lambda i: -P["votes"][i])[:FAMOUS]
    meta = {
        "n": len(P["votes"]),
        "tiers": catalog["tiers"],
        "regions": [{**r, "exampleName": P["name"][r["example"]]} for r in catalog["regions"]],
        "famous": [[i, P["name"][i]] for i in famous],
        "story": catalog["story"],
        # Perfumes listing each tour note, so the tour can light them up before the catalog loads.
        "sets": {note: bitset([i for i, (t, m, b) in enumerate(zip(P["top"], P["middle"], P["base"]))
                                if j in t or j in m or j in b], len(P["votes"]))
                 for note, j in ((nt, catalog["notes"].index(nt)) for nt in STORY_NOTES)}
        | {f"gender:{g}": bitset([i for i, x in enumerate(P["gender"]) if catalog["genders"][x] == g], len(P["votes"]))
           for g in ("men", "women")},
        "eval": catalog["meta"]["eval"],
    }
    with open(OUT / "map.json", "w") as f:
        json.dump(meta, f, separators=(",", ":"), ensure_ascii=False)


def load():
    c = pd.read_csv(RAW / "fra_cleaned.csv", sep=";", encoding="cp1252", encoding_errors="replace")
    p = pd.read_csv(RAW / "fra_perfumes.csv")
    c["fid"] = c.url.str.extract(r"-(\d+)\.html$")[0]
    p["fid"] = p.url.str.extract(r"-(\d+)\.html$")[0]
    p["url_brand"] = p.url.str.extract(r"/perfume/([^/]+)/")[0]
    p = p.drop_duplicates("fid")[["fid", "Name", "Main Accords", "url_brand"]]
    df = c.merge(p, on="fid", how="left")

    df["top"] = df.Top.map(split_notes)
    df["middle"] = df.Middle.map(split_notes)
    df["base"] = df.Base.map(split_notes)

    def accords(row):
        if isinstance(row["Main Accords"], str):
            try:
                lst = [a.strip().lower() for a in ast.literal_eval(row["Main Accords"])]
                if lst:
                    return lst
            except (ValueError, SyntaxError):
                pass
        return [row[f"mainaccord{i}"].strip().lower() for i in range(1, 6) if isinstance(row[f"mainaccord{i}"], str)]

    df["accords"] = df.apply(accords, axis=1)
    names = df.apply(display_names, axis=1)
    df["name"] = [n for n, _ in names]
    df["brand"] = [b for _, b in names]
    df["rating"] = pd.to_numeric(df["Rating Value"].astype(str).str.replace(",", "."), errors="coerce")
    df["primary"] = df["mainaccord1"].str.strip().str.lower()
    df = df[df[["top", "middle", "base"]].apply(lambda r: sum(map(len, r)) > 0, axis=1)].reset_index(drop=True)
    return df


def build_matrix(df, vocab, scheme):
    """scheme: 'binary' | 'tfidf' | 'tfidf_layer'. SHIPPED_SCHEME picks the one the app uses."""
    idx = {n: i for i, n in enumerate(vocab)}
    rows, cols, vals = [], [], []
    for r, row in enumerate(df.itertuples()):
        seen = {}
        for layer in ("top", "middle", "base"):
            w = LAYER_WEIGHTS[layer] if scheme == "tfidf_layer" else 1.0
            for n in getattr(row, layer):
                seen[idx[n]] = max(seen.get(idx[n], 0.0), w)
        for j, w in seen.items():
            rows.append(r)
            cols.append(j)
            vals.append(w)
    X = sparse.csr_matrix((vals, (rows, cols)), shape=(len(df), len(vocab)))
    df_counts = np.asarray((X > 0).sum(axis=0)).ravel()
    idf = np.log((1 + len(df)) / (1 + df_counts)) + 1.0
    if scheme != "binary":
        X = X @ sparse.diags(idf)
    return normalize(X), idf


def neighbours(X, k):
    """Exact cosine top-k by sparse matrix product in chunks (rows are L2-normalised)."""
    n = X.shape[0]
    XT = X.T.tocsc()
    ids = np.zeros((n, k), dtype=np.int32)
    sims = np.zeros((n, k), dtype=np.float32)
    for s in range(0, n, 2000):
        S = (X[s : s + 2000] @ XT).toarray()
        for i in range(S.shape[0]):
            S[i, s + i] = -1.0
        part = np.argpartition(-S, k, axis=1)[:, :k]
        ps = np.take_along_axis(S, part, axis=1)
        order = np.argsort(-ps, axis=1)
        ids[s : s + 2000] = np.take_along_axis(part, order, axis=1)
        sims[s : s + 2000] = np.take_along_axis(ps, order, axis=1)
    return ids, sims


def evaluate(df, vocab):
    """Do note-list neighbours share the crowd-voted dominant accord? Notes are the brand's
    ingredient list; accords are what thousands of wearers say it smells like, so this checks
    that the ingredient space tracks perceived smell."""
    primary = df.primary.to_numpy()
    tier = np.array([ACCORD_TIER.get(a, DEFAULT_TIER) for a in primary])

    def chance(labels):
        _, counts = np.unique(labels, return_counts=True)
        return float(((counts / counts.sum()) ** 2).sum())

    results = {"accord_chance": chance(primary), "tier_chance": chance(tier), "schemes": {}}
    for scheme in ("binary", "tfidf", "tfidf_layer"):
        X, _ = build_matrix(df, vocab, scheme)
        ids, _ = neighbours(X, 10)
        results["schemes"][scheme] = {
            "accord_p_at_10": float((primary[ids] == primary[:, None]).mean()),
            "tier_p_at_10": float((tier[ids] == tier[:, None]).mean()),
        }
    results["shipped"] = SHIPPED_SCHEME
    return results


def main():
    t0 = time.time()
    df = load()
    print(f"{len(df)} perfumes loaded ({time.time() - t0:.1f}s)")

    counts = pd.Series([n for l in ("top", "middle", "base") for ns in df[l] for n in ns]).value_counts()
    vocab = list(counts.index)  # sorted by frequency, so note ids double as popularity rank
    accord_vocab = list(pd.Series([a for lst in df.accords for a in lst]).value_counts().index)
    print(f"{len(vocab)} notes, {len(accord_vocab)} accords")

    ev = evaluate(df, vocab)
    print(json.dumps(ev, indent=2))

    X, idf = build_matrix(df, vocab, SHIPPED_SCHEME)

    import umap

    # UMAP straight on the 1,670-dim sparse vectors gives one round blob. Reducing to 64 LSA
    # dimensions first and letting points pack tightly (min_dist 0) shows the families. Extra
    # repulsion pushes the islands apart: empty space between them went from 44% to 59% of the
    # map, and 2-D neighbours kept slightly more of the true top-10 (0.104 vs 0.082 recall).
    Z = normalize(TruncatedSVD(64, random_state=SEED).fit_transform(X))
    coords = umap.UMAP(n_neighbors=30, min_dist=0.0, repulsion_strength=2.0, negative_sample_rate=10,
                       metric="cosine", random_state=SEED).fit_transform(Z)
    coords = fit_unit_square(coords)
    print(f"umap done ({time.time() - t0:.1f}s)")

    nidx = {n: i for i, n in enumerate(vocab)}
    aidx = {a: i for i, a in enumerate(accord_vocab)}
    tiers = [ACCORD_TIER.get(a, DEFAULT_TIER) for a in df.primary]
    genders = sorted(df.Gender.unique().tolist())
    countries = sorted(df.Country.unique().tolist())

    def year(v):
        return None if pd.isna(v) else int(v)

    def perfumers(row):
        names = [x for x in (row.Perfumer1, row.Perfumer2) if isinstance(x, str) and x.strip() and x != "unknown"]
        return [re.sub(r"(^|[\s\-])([a-z])", lambda m: m.group(1) + m.group(2).upper(), x) for x in names]

    catalog = {
        "meta": {
            "count": len(df),
            "source": "Fragrantica.com Fragrance Dataset (Kaggle, olgagmiufana1)",
            "scheme": SHIPPED_SCHEME,
            "k": K_NEIGHBOURS,
            "eval": ev,
        },
        "tiers": [name for name, _ in TIERS],
        "genders": genders,
        "countries": countries,
        "notes": vocab,
        "idf": [round(float(x), 4) for x in idf],
        "accords": accord_vocab,
        "accordTier": [ACCORD_TIER.get(a, DEFAULT_TIER) for a in accord_vocab],
        "perfumes": {
            "name": df.name.tolist(),
            "brand": df.brand.tolist(),
            "year": [year(v) for v in df.Year],
            "gender": [genders.index(g) for g in df.Gender],
            "country": [countries.index(c) for c in df.Country],
            "rating": [None if pd.isna(v) else round(float(v), 2) for v in df.rating],
            "votes": df["Rating Count"].astype(int).tolist(),
            "perfumers": [perfumers(r) for r in df.itertuples()],
            "url": df.url.str.replace("https://www.fragrantica.com/perfume/", "", regex=False)
                     .str.replace(r"\.html$", "", regex=True).tolist(),
            "top": [[nidx[n] for n in ns] for ns in df.top],
            "middle": [[nidx[n] for n in ns] for ns in df.middle],
            "base": [[nidx[n] for n in ns] for ns in df.base],
            "accords": [[aidx[a] for a in lst] for lst in df.accords],
            "tier": tiers,
            "weight": [round(evaporation_weight(lst), 2) for lst in df.accords],
            "x": [round(float(v), 4) for v in coords[:, 0]],
            "y": [round(float(v), 4) for v in coords[:, 1]],
        },
    }
    price_by_id, brand_prices = attach(catalog["perfumes"]["name"], catalog["perfumes"]["brand"], catalog["perfumes"]["votes"])
    catalog["prices"] = {str(i): p for i, p in sorted(price_by_id.items())}
    catalog["brandPrices"] = brand_prices
    print(f"prices: {len(price_by_id)} perfumes, {len(brand_prices)} brand ranges")
    catalog["regions"] = [r for lv, k, acc in REGION_LEVELS
                          for r in label_regions(catalog["perfumes"], vocab, accord_vocab, k, acc, lv)]
    catalog["story"] = story_stats(catalog["perfumes"], vocab)
    catalog["story"]["clone"] = clone_pair(df, X, "Baccarat Rouge 540", "Maison Francis Kurkdjian")
    catalog["budgetBrands"] = [b for b in BUDGET_HOUSES if b in set(df.brand)]
    axes = axes_coords(catalog["perfumes"]["weight"], df.accords)
    catalog["story"]["axes"] = axes_stats(axes, catalog["perfumes"]["weight"], df.Gender.tolist(), df.Year.tolist())
    OUT.mkdir(parents=True, exist_ok=True)
    write_map(catalog, coords, axes)
    # The map file carries positions; neighbours and their similarities are recomputed in the
    # browser from the note lists (exact, a few ms each), which halves the catalog download.
    for k in ("x", "y"):
        del catalog["perfumes"][k]
    with open(OUT / "catalog.json", "w") as f:
        json.dump(catalog, f, separators=(",", ":"), ensure_ascii=False)
    with open(ROOT / "pipeline" / "eval.json", "w") as f:
        json.dump(ev, f, indent=2)
    og_image.main()
    sizes = ", ".join(f"{p.name} {p.stat().st_size / 1e6:.2f} MB" for p in sorted(OUT.iterdir()))
    print(f"wrote {sizes} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
