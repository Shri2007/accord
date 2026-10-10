"""Attach price snapshots to the catalog.

Two public Kaggle datasets, both dated, neither live:

- Sephora product info (nadyinky/sephora-products-and-skincare-reviews, CC BY 4.0, Aug 2023):
  US list prices and bottle sizes for ~700 perfumes and colognes.
- eBay perfume listings (muneebmuhammadali/perfume-e-commerece-dataset, ODC-By, May 2024):
  2,000 listings with asking prices. Titles are messy and some are fakes, so matching is strict.

Matching is by brand plus perfume name after stripping concentration words and brand names.
Anything ambiguous is left unmatched rather than guessed. The app shows the source product
title, size and date next to every price, so a near-miss is visible to the reader.
"""

import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from statistics import median

import pandas as pd

RAW = Path(__file__).resolve().parents[1] / "data" / "raw" / "prices"
SEPHORA = RAW / "sephora-products-and-skincare-reviews" / "product_info.csv"
EBAY = [RAW / "perfume-e-commerece-dataset" / f for f in ("ebay_mens_perfume.csv", "ebay_womens_perfume.csv")]

SEPHORA_DATE = "Aug 2023"
EBAY_DATE = "May 2024"

BRAND_ALIAS = {
    "armani beauty": "giorgio armani",
    "armani": "giorgio armani",
    "kilian paris": "by kilian",
    "kilian": "by kilian",
    "world of chris collins": "chris collins",
    "christian dior": "dior",
    "ysl": "yves saint laurent",
    "dolce gabbana": "dolce and gabbana",
    "d and g": "dolce and gabbana",
    "calvin klein": "calvin klein",
    "carolina herrera new york": "carolina herrera",
    "lattafa": "lattafa perfumes",
    "al haramain": "al haramain perfumes",
    "maison margiela": "maison martin margiela",
}
CONCENTRATION = r"\b(eau de parfum|eau de toilette|eau de cologne|extrait de parfum|extrait|parfum|cologne|edp|edt|edc|perfume|fragrance|spray|for men|for women|pour homme spray)\b"
COLLECTION_PREFIX = r"^(replica|reserve)\s+"
NOT_A_BOTTLE = r"\b(mini|rollerball|roller|travel|body oil|body mist|hair mist|gift set|set|discovery|sampler|refill|twist|candle|lotion|shower|deodorant|soap|balm|sample|decant|vial|tester|lot)\b"
# eBay titles that are probably not the real thing.
SUSPECT = r"\b(inspired|impression|dupe|type|version|alternative|replica of|our version|smells like|compare to|generic|unbranded)\b"


def fold(s):
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = s.lower().replace("&", " and ").replace("'", "").replace("’", "").replace("‘", "")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9+]+", " ", s)).strip()


def base(name, brand_words=()):
    s = re.sub(CONCENTRATION, " ", fold(name))
    s = re.sub(COLLECTION_PREFIX, "", s.strip())
    for bw in brand_words:
        if bw and s.startswith(bw + " "):
            s = s[len(bw) + 1:]
        if bw and s.endswith(" " + bw):
            s = s[: -len(bw) - 1]
    return re.sub(r"\s+", " ", s).strip()


def concentration(s):
    f = fold(s)
    for key, val in (("extrait", "extrait"), ("eau de parfum", "edp"), ("edp", "edp"), ("eau de toilette", "edt"),
                     ("edt", "edt"), ("eau de cologne", "edc"), ("parfum", "parfum"), ("cologne", "edc")):
        if re.search(r"\b" + key + r"\b", f):
            return val
    return None


def millilitres(size):
    """'3.4 oz/ 100 mL' -> 100, '1.7 oz' -> 50. None if unparseable."""
    if not isinstance(size, str):
        return None
    f = size.lower()
    m = re.search(r"(\d+(?:\.\d+)?)\s*m\s*l", f)
    if m:
        return round(float(m.group(1)))
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?oz", f)
    if m:
        return round(float(m.group(1)) * 29.5735)
    return None


class Matcher:
    def __init__(self, names, brands, votes):
        self.names, self.votes = names, votes
        self.by_brand = defaultdict(list)
        for i, b in enumerate(brands):
            self.by_brand[fold(b)].append(i)
        self.keys = {}
        for fb, ids in self.by_brand.items():
            words = {fb, fb.split(" ")[0]} if len(fb.split(" ")[0]) > 3 else {fb}
            for i in ids:
                # A perfume named after its house ("Kenzo" by Kenzo) would match every listing
                # from that house, so it only matches exactly, never inside an eBay title.
                self.keys[i] = "" if fold(names[i]) == fb else base(names[i], sorted(words, key=len, reverse=True))

    def brand_ids(self, brand):
        fb = fold(brand)
        fb = BRAND_ALIAS.get(fb, fb)
        if fb in self.by_brand:
            return fb, self.by_brand[fb]
        for k in self.by_brand:
            if k.startswith(fb + " ") or fb.startswith(k + " "):
                return k, self.by_brand[k]
        return None, []

    def pick(self, hits, conc):
        """Several catalog entries share a base name (Sauvage EDT, EDP, Parfum...)."""
        if len(hits) == 1:
            return hits[0]
        same = [i for i in hits if concentration(self.names[i]) == conc]
        plain = [i for i in hits if concentration(self.names[i]) is None]
        pool = same or plain or hits
        return max(pool, key=lambda i: self.votes[i])

    def exact(self, brand, name):
        fb, ids = self.brand_ids(brand)
        if not ids:
            return None
        words = sorted({fb, fb.split(" ")[0]} if len(fb.split(" ")[0]) > 3 else {fb}, key=len, reverse=True)
        key = base(name, words)
        if len(key) < 2:
            return None
        hits = [i for i in ids if self.keys[i] == key]
        return self.pick(hits, concentration(name)) if hits else None

    def within(self, brand, title):
        """eBay: the longest catalog name of this brand that appears as whole words in the title."""
        fb, ids = self.brand_ids(brand)
        if not ids:
            return None
        t = " " + base(title) + " "
        hits = [i for i in ids if len(self.keys[i]) >= 4 and f" {self.keys[i]} " in t]
        if not hits:
            return None
        longest = max(len(self.keys[i]) for i in hits)
        return self.pick([i for i in hits if len(self.keys[i]) == longest], concentration(title))


def sephora_prices(m):
    df = pd.read_csv(SEPHORA)
    df = df[(df.primary_category == "Fragrance") & (df.tertiary_category.isin(["Perfume", "Cologne"]))]
    out = {}
    for r in df.itertuples():
        if re.search(NOT_A_BOTTLE, fold(r.product_name)) or pd.isna(r.price_usd):
            continue
        i = m.exact(r.brand_name, r.product_name)
        if i is None:
            continue
        usd = float(r.price_usd)
        other = [float(x) for x in (r.child_min_price, r.child_max_price) if not pd.isna(x)]
        entry = {
            "usd": usd,
            "ml": millilitres(r.size),
            "title": f"{r.brand_name} {r.product_name}".strip(),
            # Other sizes of the same product, so the range always includes the listed bottle.
            "lo": min([usd, *other]),
            "hi": max([usd, *other]),
        }
        # Several Sephora rows can land on one perfume; keep the most-loved one.
        if i not in out or (r.loves_count or 0) > out[i][1]:
            out[i] = (entry, r.loves_count or 0)
    return {i: e for i, (e, _) in out.items()}


def ebay_prices(m, retail):
    rows = pd.concat([pd.read_csv(p) for p in EBAY], ignore_index=True)
    found = defaultdict(list)
    for r in rows.itertuples():
        title = str(r.title)
        ft = fold(title)
        if pd.isna(r.price) or re.search(NOT_A_BOTTLE, ft) or re.search(SUSPECT, ft) or re.search(r"\w-\w-\w", title):
            continue
        ml = millilitres(title)
        if not ml or not 30 <= ml <= 200:  # full bottles only; travel sizes skew the price
            continue
        i = m.within(r.brand, title)
        if i is None:
            continue
        found[i].append((float(r.price), ml))
    out = {}
    for i, ls in found.items():
        ref = retail.get(i)
        if ref and ref["ml"]:
            # Far below retail per ml usually means a fake or a mislabeled listing.
            ls = [(p, ml) for p, ml in ls if p / ml >= 0.25 * ref["usd"] / ref["ml"]]
        if not ls:
            continue
        # Median over listings of the most common size only, so sizes don't blur the price.
        # Sizes within 10% are one bottle written differently (3.6 oz = 105 or 106 ml), and
        # ties go to the size nearest the standard 100 ml.
        groups = []
        for p, m in sorted(ls, key=lambda x: x[1]):
            if groups and m <= groups[-1][0][1] * 1.1:
                groups[-1].append((p, m))
            else:
                groups.append([(p, m)])
        best = max(groups, key=lambda g: (len(g), -abs(median(m for _, m in g) - 100)))
        out[i] = {"usd": round(median(p for p, _ in best), 2), "ml": round(median(m for _, m in best)), "n": len(best)}
    return out


def per100(e):
    return e["usd"] / e["ml"] * 100 if e and e.get("ml") else None


def attach(names, brands, votes):
    """Returns (prices by perfume id, brand price ranges)."""
    m = Matcher(names, brands, votes)
    retail = sephora_prices(m)
    street = ebay_prices(m, retail)
    prices = {}
    for i in set(retail) | set(street):
        p = {}
        if i in retail:
            p["retail"] = {**retail[i], "src": "Sephora", "date": SEPHORA_DATE}
        if i in street:
            p["street"] = {**street[i], "src": "eBay", "date": EBAY_DATE}
        prices[i] = p
    # Brand-level ranges let a perfume without its own price say what the house usually costs.
    by_brand = defaultdict(list)
    for i, p in prices.items():
        for kind in ("retail", "street"):
            if kind in p and p[kind].get("ml") and 20 <= p[kind]["ml"] <= 200:
                by_brand[brands[i]].append((kind, p[kind]["usd"]))
    brand_ranges = {}
    for b, xs in by_brand.items():
        kinds = {k for k, _ in xs}
        kind = "retail" if "retail" in kinds else "street"
        vals = sorted(v for k, v in xs if k == kind)
        if len(vals) >= 2:
            brand_ranges[b] = {"lo": vals[0], "hi": vals[-1], "n": len(vals),
                               "src": "Sephora" if kind == "retail" else "eBay",
                               "date": SEPHORA_DATE if kind == "retail" else EBAY_DATE}
    return prices, brand_ranges
