import type { ReactNode } from "react";
import type { Camera } from "./MapView";
import type { MapData } from "./mapdata";

export type TourStep = {
  title: string;
  body: ReactNode;
  /** small print with the measurement behind the claim */
  fine?: string;
  camera: Camera["to"];
  highlight: number[] | null;
  select: number | null;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Perfumes listing a note, for lighting them up on the map. */
export function withNote(map: MapData, note: string): number[] {
  return map.sets[note] ?? [];
}

/** Camera onto the densest patch of the given perfumes: a 24×24 grid over the map, centred on
 *  the fullest cell's points. Label anchors can sit at the edge of a cluster; this can't. */
export function densest(map: MapData, ids: number[], k: number): Camera["to"] {
  if (!ids.length) return "home";
  const P = map;
  const G = 24;
  const cells = new Map<number, number[]>();
  for (const i of ids) {
    const c = Math.min(G - 1, Math.floor(P.x[i] * G)) * G + Math.min(G - 1, Math.floor(P.y[i] * G));
    cells.set(c, [...(cells.get(c) ?? []), i]);
  }
  const best = [...cells.values()].reduce((a, b) => (b.length > a.length ? b : a));
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return { x: mean(best.map((i) => P.x[i])), y: mean(best.map((i) => P.y[i])), k };
}

/** The story of why the map looks the way it does. Every number is measured in the pipeline
 *  (catalog.story), so the copy can't drift from the data. */
export function tourSteps(map: MapData): TourStep[] {
  const s = map.story;
  const n = s.notes;
  const clone = s.clone;
  const mintRegion = map.regions.find((r) => r.level === 1 && r.label.includes("mint"));
  return [
    {
      title: "Nobody drew this map",
      body: (
        <>
          A computer read the ingredient lists of {map.n.toLocaleString()} perfumes and placed the ones that share
          ingredients close together. Every dot is one perfume; bigger dots are ones more people have rated. So
          what decides where a perfume lands?
        </>
      ),
      camera: "home",
      highlight: null,
      select: null,
    },
    {
      title: "Signature ingredients build islands",
      body: (
        <>
          These are the {n.peony.n.toLocaleString()} perfumes with peony. They bunch into one place: around a peony
          perfume, {pct(n.peony.near)} of the nearest dots contain peony too, while only {pct(n.peony.base)} of all
          perfumes do.
        </>
      ),
      fine: "Share of each perfume's 20 nearest dots on the map that list the same note.",
      camera: densest(map, withNote(map, "peony"), 2.2),
      highlight: withNote(map, "peony"),
      select: null,
    },
    {
      title: "Mint makes the fresh corner",
      body: (
        <>
          Mint does the same ({pct(n.mint.near)} against {pct(n.mint.base)}). This is the cool, blue, sporty corner
          {mintRegion ? <>, home to {mintRegion.exampleName}</> : null}. Tuberose ({pct(n.tuberose.near)}) builds
          another island for creamy white florals.
        </>
      ),
      camera: densest(map, withNote(map, "mint"), 2.2),
      highlight: withNote(map, "mint"),
      select: null,
    },
    {
      title: "Oud brings its own kit",
      body: (
        <>
          Oud perfumes cluster tightly too ({pct(n["agarwood (oud)"].near)}), partly because they reuse the same
          partners: {pct(s.saffronWithOud)} of them also list saffron, against {pct(s.saffronOverall)} of perfumes
          overall.
        </>
      ),
      camera: densest(map, withNote(map, "agarwood (oud)"), 2.2),
      highlight: withNote(map, "agarwood (oud)"),
      select: null,
    },
    {
      title: "Common ingredients go everywhere",
      body: (
        <>
          Musk is in {n.musk.n.toLocaleString()} perfumes, almost half of them, so it is sprinkled across the whole map.
          Around a musk perfume, {pct(n.musk.near)} of neighbours have musk, barely above the {pct(n.musk.base)}{" "}
          average. Rare ingredients decide where a perfume lands; common ones don't.
        </>
      ),
      camera: "home",
      highlight: withNote(map, "musk"),
      select: null,
    },
    {
      title: "Dots on top of dots are clones",
      body: (
        <>
          {clone.aName} sits on the same spot as {clone.bName} by {clone.bBrand}, because their ingredient lists are{" "}
          {pct(clone.sim)} alike. When two dots overlap like this, one is usually a copy of the other.
        </>
      ),
      camera: "selection",
      highlight: null,
      select: clone.a,
    },
    {
      title: "Shade shows light or heavy",
      body: (
        <>
          Pale dots are light and fresh; dark dots are heavy and warm. There's no single light-to-heavy direction
          across the map. Instead, every neighbourhood has its own lighter and heavier pockets, because a perfume can
          share ingredients with lighter or heavier ones.
        </>
      ),
      fine: `A dot's shade predicts its neighbours' shade fairly well (r = ${s.weightLocal.toFixed(2)}), but the map's left-right and up-down position barely does (R² = ${s.weightGlobalR2.toFixed(2)}).`,
      camera: "home",
      highlight: null,
      select: null,
    },
    {
      title: "Your turn",
      body: <>Search a perfume you know and the map will fly you to it. Or click any dot.</>,
      camera: "home",
      highlight: null,
      select: null,
    },
  ];
}

export function TourCard(props: { steps: TourStep[]; at: number; onGo: (i: number) => void; onClose: () => void }) {
  const { steps, at, onGo, onClose } = props;
  const step = steps[at];
  const last = at === steps.length - 1;
  return (
    <div className="tour" role="dialog" aria-label="Map tour" aria-live="polite">
      <div className="tour-top">
        <span className="tour-count">
          {at + 1} / {steps.length}
        </span>
        <button className="tour-x" onClick={onClose} aria-label="Close tour">
          ×
        </button>
      </div>
      <h2>{step.title}</h2>
      <p>{step.body}</p>
      {step.fine && <p className="tour-fine">{step.fine}</p>}
      <div className="tour-nav">
        <button className="ghost" onClick={() => onGo(at - 1)} disabled={at === 0}>
          Back
        </button>
        <div className="tour-dots" aria-hidden="true">
          {steps.map((_, i) => (
            <span key={i} className={i === at ? "on" : ""} />
          ))}
        </div>
        <button className="primary-btn" onClick={() => (last ? onClose() : onGo(at + 1))}>
          {last ? "Start exploring" : "Next"}
        </button>
      </div>
    </div>
  );
}
