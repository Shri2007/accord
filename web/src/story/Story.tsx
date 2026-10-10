import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import MapView, { type Camera, type Layout } from "../MapView";
import { densest, withNote } from "../Tour";
import { loadMap, type MapData } from "../mapdata";

type Step = {
  title: string;
  body: ReactNode;
  /** the measurement behind the claim, in small print */
  fine?: string;
  layout: Layout;
  camera: Camera["to"];
  highlight: number[] | null;
  selected: number | null;
  /** a second perfume to ring and name, without selecting it */
  preview?: number;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const PHONE = "(max-width: 860px)";

/** Every number in the copy comes from map.json, measured by the pipeline. */
function steps(map: MapData): Step[] {
  const s = map.story;
  const n = s.notes;
  const ax = s.axes;
  const w = ax.byWeight;
  const g = ax.byGender;
  const era = ax.byEra;
  const mint = map.regions.find((r) => r.level === 1 && r.label.includes("mint"));
  const islands = { layout: "islands" as const, highlight: null, selected: null };
  const axes = { layout: "axes" as const, camera: "home" as const, highlight: null, selected: null };
  return [
    {
      ...islands,
      title: "Every dot is a perfume",
      body: (
        <>
          There are {map.n.toLocaleString()} of them. Bigger dots are perfumes more people have rated, so the famous
          ones stand out. The shade is how heavy a scent is: pale for light and fresh, dark for warm and heavy.
        </>
      ),
      camera: "home",
    },
    {
      ...islands,
      title: "Signature ingredients build islands",
      body: (
        <>
          Here are the {n.peony.n.toLocaleString()} perfumes that list peony. They don't scatter. Around a peony
          perfume, {pct(n.peony.near)} of the nearest dots contain peony too, while only {pct(n.peony.base)} of all
          perfumes do.
        </>
      ),
      fine: "Share of each perfume's 20 nearest dots on the map that list the same note.",
      camera: densest(map, withNote(map, "peony"), 2.2),
      highlight: withNote(map, "peony"),
    },
    {
      ...islands,
      title: "Mint has a corner of its own",
      body: (
        <>
          Mint does the same ({pct(n.mint.near)} against {pct(n.mint.base)}). This is the cool, sporty blue corner
          {mint ? <>, home to {mint.exampleName}</> : null}. Tuberose builds another island for creamy
          white florals ({pct(n.tuberose.near)}).
        </>
      ),
      camera: densest(map, withNote(map, "mint"), 2.2),
      highlight: withNote(map, "mint"),
    },
    {
      ...islands,
      title: "Oud brings its own kit",
      body: (
        <>
          Oud perfumes cluster tightly too ({pct(n["agarwood (oud)"].near)}), partly because they reuse the same
          partners. {pct(s.saffronWithOud)} of them also list saffron, a note found in only {pct(s.saffronOverall)} of
          perfumes overall.
        </>
      ),
      camera: densest(map, withNote(map, "agarwood (oud)"), 2.2),
      highlight: withNote(map, "agarwood (oud)"),
    },
    {
      ...islands,
      title: "Common ingredients go everywhere",
      body: (
        <>
          Musk is in {n.musk.n.toLocaleString()} perfumes, nearly half of them, so it is sprinkled across the whole
          map. Around a musk perfume, {pct(n.musk.near)} of neighbours have musk, barely above the{" "}
          {pct(n.musk.base)} average. The rare ingredients decide where a perfume lands. The common ones don't.
        </>
      ),
      camera: "home",
      highlight: withNote(map, "musk"),
    },
    {
      ...islands,
      title: "Dots on top of dots are clones",
      body: (
        <>
          Zoom all the way in on {s.clone.aName}, one of the most-rated perfumes in the catalog. Sitting on the same
          spot is {s.clone.bName} by {s.clone.bBrand}. Their ingredient lists are {pct(s.clone.sim)} alike. When two
          dots overlap like this, one is usually a copy of the other.
        </>
      ),
      camera: "selection",
      highlight: [s.clone.a, s.clone.b],
      selected: s.clone.a,
      preview: s.clone.b,
    },
    {
      ...islands,
      title: "Light and heavy live side by side",
      body: (
        <>
          You might expect the fresh scents on one side of the map and the heavy ones on the other. They aren't. Every
          island has its own lighter and darker patches, because a perfume shares ingredients with lighter and heavier
          ones alike.
        </>
      ),
      fine: `A dot's shade predicts its neighbours' shade fairly well (r = ${s.weightLocal.toFixed(2)}); its position on the map barely does (R² = ${s.weightGlobalR2.toFixed(2)}).`,
      camera: "home",
    },
    {
      ...axes,
      title: "Now line them up",
      body: (
        <>
          Forget the islands. Sort every perfume by two things instead: how heavy it is, from left to right, and
          whether it leans floral or woody, from bottom to top. Same dots, new places.
        </>
      ),
      fine: "Heaviness is a weighted average of each perfume's voted accords, from citrus (1) to musk and oud (6). Floral versus woody uses the same votes. The two are nearly independent (r = −0.14), so the chart isn't saying one thing twice.",
    },
    {
      ...axes,
      title: "Most perfumes are neither",
      body: (
        <>
          Only {pct(ax.floral)} of perfumes lean clearly floral and {pct(ax.woody)} clearly woody. Florals bunch in
          the middle weights: {pct(w.mid.floral)} of mid-weight perfumes against {pct(w.light.floral)} of light ones and{" "}
          {pct(w.heavy.floral)} of heavy ones. Woodiness climbs with weight, from {pct(w.light.woody)} of light perfumes
          to {pct(w.heavy.woody)} of heavy ones.
        </>
      ),
      fine: "“Floral” and “woody” here mean the top and bottom thirds of the vertical axis.",
    },
    {
      ...axes,
      title: "The men's aisle",
      body: (
        <>
          These are the {g.men.n.toLocaleString()} perfumes sold to men. They sit low and to the left: {pct(g.men.woody)}{" "}
          lean woody, {pct(g.men.floral)} lean floral, and they are the lightest group on
          average ({g.men.weight.toFixed(2)} on the 1–6 scale).
        </>
      ),
      highlight: map.sets["gender:men"],
    },
    {
      ...axes,
      title: "The women's aisle",
      body: (
        <>
          The {g.women.n.toLocaleString()} perfumes sold to women mirror it: {pct(g.women.floral)} lean floral and just{" "}
          {pct(g.women.woody)} woody. Unisex perfumes split the difference on floral and woody, and they are the
          heaviest of the three ({g.unisex.weight.toFixed(2)} against {g.women.weight.toFixed(2)} for women).
        </>
      ),
      highlight: map.sets["gender:women"],
    },
    {
      ...axes,
      title: "Perfume is getting heavier",
      body: (
        <>
          Perfumes released since 2016 average {era["2016-2024"].weight.toFixed(2)} on the weight scale, up from{" "}
          {era["1980-1999"].weight.toFixed(2)} for those from 1980 to 1999. The floral share fell from{" "}
          {pct(era["1980-1999"].floral)} to {pct(era["2016-2024"].floral)} over the same stretch.
        </>
      ),
      fine: `${era["1980-1999"].n.toLocaleString()} perfumes from 1980–1999 against ${era["2016-2024"].n.toLocaleString()} from 2016 on. Older perfumes are fewer, and the ones still listed may lean toward classics that stayed popular.`,
    },
    {
      ...islands,
      title: "Find your own",
      body: (
        <>
          Every perfume you know is somewhere on this map, next to the ones that smell most like it. Search one, see
          what it costs, and find a cheaper bottle that lists the same ingredients.
        </>
      ),
      camera: "home",
    },
  ];
}

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

export default function Story() {
  const [map, setMap] = useState<MapData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [camera, setCamera] = useState<Camera>({ key: 0, to: "home" });
  const compact = useMedia(PHONE);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const list = useMemo(() => (map ? steps(map) : []), [map]);

  useEffect(() => {
    loadMap().then(setMap, (e) => setErr(String(e)));
  }, []);

  // The step crossing the middle of the screen drives the figure.
  useEffect(() => {
    if (!list.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step));
      },
      { rootMargin: "-50% 0px -50% 0px" }
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [list]);

  useEffect(() => {
    if (list[active]) setCamera((c) => ({ key: c.key + 1, to: list[active].camera }));
  }, [active, list]);

  if (err) return <div className="boot">Could not load the map. {err}</div>;
  const step = list[active];

  return (
    <div className="story">
      <header className="s-hero">
        <a className="s-brand" href="/">
          Accord
        </a>
        <p className="s-kicker">A data story</p>
        <h1>How 24,063 perfumes sort themselves</h1>
        <p className="s-dek">
          Nobody drew the map below. A computer read every perfume's ingredient list and put the ones that share
          ingredients next to each other. Here is what came out, and why it looks the way it does.
        </p>
        <p className="s-byline">
          By Shri Charan Sriram · Data from Fragrantica via Kaggle · <a href="/">Open the interactive map</a>
        </p>
        <p className="s-cue" aria-hidden="true">
          Scroll ↓
        </p>
      </header>

      <div className="s-scrolly">
        <div className="s-figure" aria-hidden={compact ? undefined : false}>
          {map && step ? (
            <MapView
              map={map}
              ix={null}
              theme=""
              layout={step.layout}
              selected={step.selected}
              highlight={step.highlight}
              preview={step.preview ?? null}
              labels={{ [map.story.clone.a]: map.story.clone.aName, [map.story.clone.b]: map.story.clone.bName }}
              insetBottom={compact ? Math.round(window.innerHeight * 0.42) : 0}
              camera={camera}
              compact={compact}
              interactive={false}
            />
          ) : (
            <div className="boot">Drawing 24,063 perfumes…</div>
          )}
        </div>
        <div className="s-steps">
          {list.map((st, i) => (
            <section
              key={st.title}
              className={i === active ? "s-step is-active" : "s-step"}
              data-step={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
            >
              <div className="s-card">
                <p className="s-num">
                  {i + 1} / {list.length}
                </p>
                <h2>{st.title}</h2>
                <p>{st.body}</p>
                {st.fine && <p className="s-fine">{st.fine}</p>}
                {i === list.length - 1 && (
                  <a className="primary-btn s-cta" href="/">
                    Open the map
                  </a>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>

      {map && <Method map={map} />}
    </div>
  );
}

function Method({ map }: { map: MapData }) {
  const ev = map.eval;
  const shipped = ev.schemes[ev.shipped];
  return (
    <section className="s-method">
      <h2>How this was made</h2>
      <p>
        The data is a public Kaggle export of Fragrantica, {map.n.toLocaleString()} perfumes with their note pyramids and
        the accords people voted for. Each ingredient list becomes a vector in which rare notes count for more than
        common ones (TF-IDF). The map squeezes those vectors into two dimensions with UMAP, after a first pass down to 64
        dimensions.
      </p>
      <p>
        To check the map means something, I compared it with what wearers say. A perfume's ten closest matches by
        ingredients share its most-voted accord {pct(shipped.accord_p_at_10)} of the time, against{" "}
        {pct(ev.accord_chance)} by chance: {(shipped.accord_p_at_10 / ev.accord_chance).toFixed(1)} times better. I
        expected that counting the base notes extra, since they are what's left after the drydown, would help. It made
        the matches worse, so every note counts the same.
      </p>
      <p>
        Two caveats. A shared ingredient list isn't a shared smell: concentration and quality matter, and the lists come
        from brands. And the map's distances are approximate, because 1,670 dimensions don't fit into two without some
        squeezing. The "smells similar" lists in the app use the exact comparison, not the map.
      </p>
      <p className="s-fine">
        Built by Shri Charan Sriram. The interactive map adds prices, sample links and a blind-buy check for every
        perfume. <a href="/">Open Accord →</a>
      </p>
    </section>
  );
}
