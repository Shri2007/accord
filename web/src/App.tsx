import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Detail, { WEIGHT_WORDS } from "./Detail";
import MapView, { type Camera, type Layout } from "./MapView";
import { TourCard, tourSteps } from "./Tour";
import { byNotes, fold, loadCatalog, loadOwned, saveOwned, search, type Index } from "./data";
import { loadMap, type MapData } from "./mapdata";

type Mode = "find" | "notes";
type Sheet = "peek" | "half" | "full";

const GUIDE_KEY = "accord:guide-seen";
const PHONE = "(max-width: 860px)";
const PEEK = 132;

function useMedia(q: string) {
  const [on, setOn] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [q]);
  return on;
}

function useViewportHeight() {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const f = () => setH(window.innerHeight);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return h;
}

export default function App() {
  const [map, setMap] = useState<MapData | null>(null);
  const [ix, setIx] = useState<Index | null>(null);
  const [layout, setLayout] = useState<Layout>("islands");
  const [err, setErr] = useState<string | null>(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "");
  const [mode, setMode] = useState<Mode>("find");
  const [selected, setSelected] = useState<number | null>(null);
  const [liked, setLiked] = useState<number[]>([]);
  const [ownedUrls, setOwnedUrls] = useState(loadOwned);
  const [camera, setCamera] = useState<Camera>({ key: 0, to: "home" });
  const [preview, setPreview] = useState<number | null>(null);
  const [guide, setGuide] = useState(() => !localStorage.getItem(GUIDE_KEY) && !location.hash);
  const [tourAt, setTourAt] = useState<number | null>(null);
  const [sheet, setSheet] = useState<Sheet>("peek");
  const [dragH, setDragH] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const compact = useMedia(PHONE);
  const vh = useViewportHeight();

  const sheetHeights: Record<Sheet, number> = { peek: PEEK, half: Math.round(vh * 0.52), full: Math.round(vh * 0.9) };
  const fly = (to: Camera["to"]) => setCamera((c) => ({ key: c.key + 1, to }));

  /** Select a perfume and fly the map to it. */
  const pick = (i: number) => {
    setMode("find");
    setSelected(i);
    setPreview(null);
    fly("selection");
    if (compact) setSheet("half");
  };
  const closeGuide = () => {
    setGuide(false);
    localStorage.setItem(GUIDE_KEY, "1");
  };

  // Two downloads start together: the small map file paints the map within moments, the
  // catalog (names, notes, prices) follows and switches on search and details.
  useEffect(() => {
    loadMap().then(setMap, (e) => setErr(String(e)));
    loadCatalog().then(setIx, (e) => setErr(String(e)));
  }, []);

  // Deep links: #f=<fragrantica path> keeps a selection shareable across rebuilds.
  useEffect(() => {
    if (!ix) return;
    const m = location.hash.match(/^#f=(.+)$/);
    if (m) {
      // Older links carry the ".html" suffix that catalog URLs no longer have.
      const i = ix.c.perfumes.url.indexOf(decodeURIComponent(m[1]).replace(/\.html$/, ""));
      if (i >= 0) pick(i);
    }
  }, [ix]);

  useEffect(() => {
    if (!ix || selected == null) return;
    history.replaceState(null, "", `#f=${encodeURIComponent(ix.c.perfumes.url[selected])}`);
  }, [ix, selected]);

  const owned = useMemo(() => {
    const s = new Set<number>();
    if (!ix) return s;
    ix.c.perfumes.url.forEach((u, i) => ownedUrls.has(u) && s.add(i));
    return s;
  }, [ix, ownedUrls]);

  const noteHits = useMemo(() => (ix ? byNotes(ix, liked) : []), [ix, liked]);
  const steps = useMemo(() => (map ? tourSteps(map) : []), [map]);

  const toggleTheme = () => {
    const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("accord:theme", next);
    setTheme(next);
  };

  const toggleOwned = (i: number) => {
    const u = ix!.c.perfumes.url[i];
    const next = new Set(ownedUrls);
    next.has(u) ? next.delete(u) : next.add(u);
    saveOwned(next);
    setOwnedUrls(next);
  };

  const goTour = (at: number) => {
    const step = steps[at];
    if (!step) return;
    setGuide(false);
    localStorage.setItem(GUIDE_KEY, "1");
    setTourAt(at);
    setLayout("islands"); // the tour's camera moves are in island coordinates
    setMode("find");
    setSelected(step.select);
    if (compact) setSheet("peek");
    fly(step.camera);
  };
  const endTour = (explore: boolean) => {
    setTourAt(null);
    setSelected(null);
    if (explore) {
      fly("home");
      searchRef.current?.focus();
    }
  };

  if (err) return <div className="boot">Could not load the map. {err}</div>;
  if (!map) return <div className="boot">Drawing 24,063 perfumes…</div>;

  const tourHighlight = tourAt != null ? steps[tourAt].highlight : null;
  const highlight = tourHighlight ?? (mode === "notes" && liked.length ? noteHits.map((h) => h.id) : null);
  // On phones the tour card replaces the sheet at the bottom; moves centre above whichever shows.
  const TOUR_CARD = 250;
  const insetBottom = !compact ? 0 : tourAt != null ? TOUR_CARD : sheetHeights[sheet === "full" ? "half" : sheet];
  const tourCard = tourAt != null && (
    <TourCard steps={steps} at={tourAt} onGo={goTour} onClose={() => endTour(tourAt === steps.length - 1)} />
  );

  const panel = (
    <>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === "find"} onClick={() => setMode("find")}>
          {selected != null ? "This perfume" : "Start here"}
        </button>
        <button role="tab" aria-selected={mode === "notes"} onClick={() => setMode("notes")}>
          Start from ingredients
        </button>
      </div>
      {!ix ? (
        <CatalogLoading />
      ) : mode === "find" ? (
        selected == null ? (
          <Intro ix={ix} compact={compact} onPick={pick} onTour={() => goTour(0)} />
        ) : (
          <Detail
            ix={ix}
            i={selected}
            onSelect={pick}
            owned={owned}
            onOwn={toggleOwned}
            onLocate={() => {
              fly("selection");
              if (compact) setSheet("peek");
            }}
          />
        )
      ) : (
        <Notes ix={ix} liked={liked} setLiked={setLiked} hits={noteHits} onPick={pick} />
      )}
    </>
  );

  return (
    <div className={compact ? "page is-compact" : "page"}>
      <header className="top">
        <div className="brand">
          <h1>Accord</h1>
          <p>
            Find perfumes that smell like the ones you already love. Search one you know to see what's in it, what
            smells like it, what it costs, and where to get a cheap sample before you spend on a bottle.
          </p>
        </div>
        <nav className="top-nav">
          <a href="/story">{compact ? "The story" : "How 24,000 perfumes organize themselves →"}</a>
          <button className="ghost" onClick={toggleTheme} aria-label="Switch light or dark theme">
            Theme
          </button>
        </nav>
      </header>

      <main className="stage">
        <section className="map-col" aria-label="Map of perfumes">
          <div className="map-frame">
            <MapView
              map={map}
              ix={ix}
              layout={layout}
              onLayout={setLayout}
              theme={theme}
              selected={mode === "find" ? selected : null}
              highlight={highlight}
              owned={owned}
              preview={preview}
              camera={camera}
              insetBottom={insetBottom}
              insetTop={compact ? 92 : 56}
              compact={compact}
              onSelect={(i) => {
                if (tourAt != null) setTourAt(null);
                setMode("find");
                setSelected(i);
                if (compact) {
                  setSheet("half");
                  fly("selection");
                }
              }}
              onHelp={() => setGuide(true)}
              onTour={() => goTour(0)}
            >
              <div className="map-search">
                <SearchBox ix={ix} onSelect={pick} onPreview={setPreview} inputRef={searchRef} />
                {compact && <LegendMini />}
              </div>
            </MapView>
            {guide && <Guide onClose={closeGuide} onTour={() => goTour(0)} />}
            {compact && tourCard && (
              <div className="tour-wrap" style={{ bottom: 8 }}>
                {tourCard}
              </div>
            )}
          </div>
          {!compact && <Legend tiers={map.tiers} ownedCount={owned.size} />}
        </section>

        {compact ? (
          <aside
            className={`panel sheet is-${sheet}${dragH != null ? " is-dragging" : ""}${tourAt != null ? " is-hidden" : ""}`}
            style={{ height: dragH ?? sheetHeights[sheet] }}
            aria-label="Perfume details"
          >
            <SheetHandle
              sheet={sheet}
              heights={sheetHeights}
              onDrag={setDragH}
              onSnap={(s) => {
                setDragH(null);
                setSheet(s);
              }}
            />
            <div className="sheet-body">
              {panel}
              {ix && mode === "find" && selected == null && (
                <details className="method-mini">
                  <summary>How the map works</summary>
                  <Method ix={ix} />
                </details>
              )}
            </div>
          </aside>
        ) : (
          <aside className="panel">{tourCard || panel}</aside>
        )}
      </main>

      {!compact && ix && <Method ix={ix} />}
    </div>
  );
}

/** Drag or tap the grip to move the phone sheet between peek, half and full. */
function SheetHandle(props: {
  sheet: Sheet;
  heights: Record<Sheet, number>;
  onDrag: (h: number | null) => void;
  onSnap: (s: Sheet) => void;
}) {
  const { sheet, heights, onDrag, onSnap } = props;
  const start = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const order: Sheet[] = ["peek", "half", "full"];
  return (
    <button
      className="sheet-handle"
      aria-label={sheet === "full" ? "Shrink details" : "Expand details"}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { y: e.clientY, h: heights[sheet], moved: false };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const dy = s.y - e.clientY;
        if (Math.abs(dy) > 6) s.moved = true;
        if (s.moved) onDrag(Math.max(heights.peek, Math.min(heights.full, s.h + dy)));
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        if (!s) return;
        if (!s.moved) {
          onSnap(order[(order.indexOf(sheet) + 1) % order.length]);
          return;
        }
        const h = Math.max(heights.peek, Math.min(heights.full, s.h + (s.y - e.clientY)));
        onSnap(order.reduce((a, b) => (Math.abs(heights[b] - h) < Math.abs(heights[a] - h) ? b : a)));
      }}
    >
      <span />
    </button>
  );
}

function Guide({ onClose, onTour }: { onClose: () => void; onTour: () => void }) {
  return (
    <div className="guide" role="dialog" aria-labelledby="guide-title">
      <div className="guide-card">
        <h2 id="guide-title">How to read this map</h2>
        <ol>
          <li>
            <strong>Every dot is one perfume.</strong> There are 24,063 of them. Bigger dots are more popular.
          </li>
          <li>
            <strong>Dots close together smell alike,</strong> because they share ingredients. Labels name each
            neighbourhood and a famous perfume that lives there.
          </li>
          <li>
            <strong>Pale dots are light and fresh. Dark dots are heavy and warm.</strong>
          </li>
          <li>
            <strong>Search any perfume and the map flies you there.</strong> Zoom with scroll or pinch, drag to move,
            and click a dot to see what it is, what it costs, and where to try it.
          </li>
        </ol>
        <div className="guide-actions">
          <button className="primary-btn" onClick={onTour}>
            Take the 1-minute tour
          </button>
          <button className="ghost" onClick={onClose}>
            Explore on my own
          </button>
        </div>
      </div>
    </div>
  );
}

function Legend({ tiers, ownedCount }: { tiers: string[]; ownedCount: number }) {
  return (
    <div className="legend">
      <span className="legend-end">Light & fresh</span>
      <ol aria-label="Dot shading, light to heavy">
        {tiers.map((t, i) => (
          <li key={t} title={`${WEIGHT_WORDS[i]}: ${t}`}>
            <span className="sw" style={{ background: `var(--tier-${i})` }} />
            <span className="legend-name">{t}</span>
          </li>
        ))}
      </ol>
      <span className="legend-end">Heavy & warm</span>
      {ownedCount > 0 && (
        <span className="legend-owned">
          <span className="ring" /> Your shelf ({ownedCount})
        </span>
      )}
    </div>
  );
}

function LegendMini() {
  return (
    <div className="legend-mini" aria-label="Dot shading: pale is light and fresh, dark is heavy and warm">
      <span>Light</span>
      {[0, 1, 2, 3, 4, 5].map((t) => (
        <span key={t} className="sw" style={{ background: `var(--tier-${t})` }} />
      ))}
      <span>Heavy</span>
    </div>
  );
}

function SearchBox(props: {
  ix: Index | null;
  onSelect: (i: number) => void;
  onPreview: (i: number | null) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { ix, onSelect, onPreview, inputRef } = props;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => (ix ? search(ix, q, 8) : []), [ix, q]);
  useEffect(() => onPreview(results[active] ?? null), [results, active]);
  const choose = (i: number) => {
    onSelect(i);
    setQ("");
    inputRef.current?.blur();
  };
  return (
    <div className="search">
      <input
        ref={inputRef}
        type="search"
        placeholder={ix ? "Find a perfume on the map, e.g. Sauvage" : "Loading search…"}
        disabled={!ix}
        value={q}
        aria-label="Find a perfume on the map"
        enterKeyHint="go"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onBlur={() => setTimeout(() => onPreview(null), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(results.length - 1, a + 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
          else if (e.key === "Enter" && results[active] != null) choose(results[active]);
          else if (e.key === "Escape") setQ("");
          else return;
          e.preventDefault();
        }}
      />
      {q && ix && (
        <ul className="results" role="listbox">
          {results.length === 0 && <li className="empty">Nothing matches “{q}”.</li>}
          {results.map((i, k) => (
            <li key={i} role="option" aria-selected={k === active}>
              <button onMouseEnter={() => setActive(k)} onClick={() => choose(i)}>
                <span className="r-name">{ix.c.perfumes.name[i]}</span>
                <span className="r-sub">
                  {ix.c.perfumes.brand[i]}
                  {ix.c.perfumes.year[i] ? ` · ${ix.c.perfumes.year[i]}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CatalogLoading() {
  return (
    <div className="intro" aria-live="polite">
      <p className="intro-lead">Loading names, notes and prices…</p>
      <div className="loading-bar" role="progressbar" aria-label="Loading the catalog">
        <span />
      </div>
      <p className="hint">The map already works: zoom, drag, switch layouts, or take the tour while this finishes.</p>
    </div>
  );
}

const SUGGESTED = ["Sauvage Dior", "Baccarat Rouge 540", "Light Blue", "Black Opium", "Aventus", "Acqua di Gio Giorgio"];

function Intro({ ix, compact, onPick, onTour }: { ix: Index; compact: boolean; onPick: (i: number) => void; onTour: () => void }) {
  const P = ix.c.perfumes;
  const suggestions = useMemo(
    () => SUGGESTED.map((s) => search(ix, s, 1)[0]).filter((i): i is number => i != null),
    [ix]
  );
  return (
    <div className="intro">
      <p className="intro-lead">New to perfume? Start with one you've smelled before.</p>
      <ol className="steps">
        <li>Search it {compact ? "at the top" : "above the map"}, or tap a popular one below.</li>
        <li>See what it smells like, what it costs, and what smells similar.</li>
        <li>Check if it's safe to buy unsmelled, then grab a sample.</li>
      </ol>
      <div className="chips">
        {suggestions.map((i) => (
          <button key={i} className="chip" onClick={() => onPick(i)}>
            {P.name[i]}
          </button>
        ))}
      </div>
      <button className="tour-link" onClick={onTour}>
        Why is the map shaped like this? Take the 1-minute tour →
      </button>
    </div>
  );
}

const MOODS: [string, string, string[]][] = [
  ["Fresh & clean", "like a cold shower", ["bergamot", "lavender", "sea notes"]],
  ["Sweet & cozy", "dessert-like", ["vanilla", "tonka bean", "caramel"]],
  ["Woody", "dry, calm, grown-up", ["sandalwood", "cedar", "vetiver"]],
  ["Floral", "a fresh bouquet", ["rose", "jasmine", "peony"]],
  ["Smoky & dark", "incense and oud", ["incense", "agarwood (oud)", "leather"]],
  ["Fruity", "juicy and bright", ["peach", "black currant", "pear"]],
];

function Notes({ ix, liked, setLiked, hits, onPick }: { ix: Index; liked: number[]; setLiked: (l: number[]) => void; hits: ReturnType<typeof byNotes>; onPick: (i: number) => void }) {
  const [q, setQ] = useState("");
  const N = ix.c.notes;
  const P = ix.c.perfumes;
  const options = useMemo(() => {
    const f = fold(q);
    if (!f) return [];
    const out: number[] = [];
    for (let j = 0; j < N.length && out.length < 8; j++) if (!liked.includes(j) && fold(N[j]).includes(f)) out.push(j);
    return out;
  }, [q, liked]);
  const add = (j: number) => {
    setLiked([...liked, j]);
    setQ("");
  };
  return (
    <div className="notes-mode">
      <p className="intro-line">
        Don't have a favourite yet? Pick a mood, or add ingredients you like. Matching perfumes light up on the map.
      </p>
      {liked.length === 0 && (
        <div className="moods">
          {MOODS.map(([name, sub, set]) => (
            <button key={name} className="mood" onClick={() => setLiked(set.map((s) => N.indexOf(s)).filter((j) => j >= 0))}>
              <strong>{name}</strong>
              <span>{sub}</span>
            </button>
          ))}
        </div>
      )}
      <div className="search">
        <input
          type="search"
          value={q}
          placeholder="Add an ingredient: vanilla, rose, coffee…"
          aria-label="Add an ingredient"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && options[0] != null) add(options[0]);
          }}
        />
        {q && (
          <ul className="results">
            {options.length === 0 && <li className="empty">No ingredient called “{q}”.</li>}
            {options.map((j) => (
              <li key={j}>
                <button onClick={() => add(j)}>
                  <span className="r-name">{N[j]}</span>
                  <span className="r-sub">in {ix.noteCount[j].toLocaleString()} perfumes</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {liked.length > 0 && (
        <>
          <div className="chips">
            {liked.map((j) => (
              <button key={j} className="chip on" onClick={() => setLiked(liked.filter((x) => x !== j))} aria-label={`Remove ${N[j]}`}>
                {N[j]} ×
              </button>
            ))}
            <button className="chip" onClick={() => setLiked([])}>
              Clear
            </button>
          </div>
          <ol className="nn">
            {hits.map((h) => (
              <li key={h.id}>
                <button onClick={() => onPick(h.id)}>
                  <span className="sim">
                    <span style={{ width: `${h.score * 100}%` }} />
                  </span>
                  <span className="nn-text">
                    <span className="r-name">{P.name[h.id]}</span>
                    <span className="r-sub">
                      {P.brand[h.id]} · has {h.matched.map((j) => N[j]).join(", ")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function Method({ ix }: { ix: Index }) {
  const ev = ix.c.meta.eval;
  const shipped = ev.schemes[ev.shipped];
  const label: Record<string, string> = {
    binary: "Binary note presence",
    tfidf: "TF-IDF, all layers equal",
    tfidf_layer: "TF-IDF, base notes weighted up",
  };
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return (
    <section className="method">
      <h2>For the curious: how the map works</h2>
      <div className="method-grid">
        <div>
          <p>
            Each perfume's ingredient list becomes a vector over {ix.c.notes.length.toLocaleString()} notes. Rare notes
            get more weight (TF-IDF), so two perfumes that share matcha say more than two that share musk. "Smells
            similar" is exact cosine top-{ix.c.meta.k}. The map squeezes the same vectors to 64 dimensions (LSA), then
            to two with UMAP, so distances on the map are approximate; the similar list is not. Neighbourhood labels
            come from clustering the map and naming each cluster by its most over-represented ingredients.
          </p>
          <p>
            The check: ingredient lists come from the brand, while accords are what thousands of wearers voted it smells
            like. If ingredient space means anything, a perfume's neighbours should share its top-voted accord. They do{" "}
            {(shipped.accord_p_at_10 / ev.accord_chance).toFixed(1)}× more often than chance. Weighting base notes up
            seemed right, since they are what survives the drydown, but it made things worse, so every layer counts
            equally.
          </p>
          <p className="fine">
            Data: {ix.c.meta.source}, {ix.n.toLocaleString()} perfumes. No scraping; links go to the source pages and to
            live store searches. The blind-buy check and the affordable-house list are hand-made rules of thumb.
          </p>
        </div>
        <table>
          <caption>Share of 10 nearest neighbours matching the perfume's own label</caption>
          <thead>
            <tr>
              <th scope="col">Vectors</th>
              <th scope="col">Top accord</th>
              <th scope="col">Light/heavy tier</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(ev.schemes).map(([k, s]) => (
              <tr key={k} className={k === ev.shipped ? "shipped" : ""}>
                <th scope="row">
                  {label[k] ?? k}
                  {k === ev.shipped ? " (shipped)" : ""}
                </th>
                <td>{pct(s.accord_p_at_10)}</td>
                <td>{pct(s.tier_p_at_10)}</td>
              </tr>
            ))}
            <tr className="chance">
              <th scope="row">Random pick</th>
              <td>{pct(ev.accord_chance)}</td>
              <td>{pct(ev.tier_chance)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
