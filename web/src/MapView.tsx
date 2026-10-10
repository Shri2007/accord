import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { neighbours, type Index } from "./data";
import type { MapData } from "./mapdata";

/** Where the map should move. A new `key` triggers the move, even to the same place. */
export type Camera = { key: number; to: "home" | "selection" | { x: number; y: number; k: number } };

export type Layout = "islands" | "axes";

type Props = {
  map: MapData;
  /** Full catalog; null while it is still downloading. Names, hover and selection need it. */
  ix: Index | null;
  theme: string;
  layout: Layout;
  selected: number | null;
  highlight: number[] | null;
  owned?: Set<number>;
  /** A search result being hovered: ringed on the map without moving it. */
  preview?: number | null;
  camera: Camera;
  /** Pixels of map hidden under the phone bottom sheet, so moves centre in what is visible. */
  insetBottom?: number;
  /** Pixels at the top taken by overlays (search, toggles); axis labels start below them. */
  insetTop?: number;
  /** Names for perfumes the map should be able to label before the catalog arrives. */
  labels?: Record<number, string>;
  compact: boolean;
  /** false for the explainer page: a figure driven by scrolling, not by the pointer */
  interactive?: boolean;
  onSelect?: (i: number) => void;
  onHelp?: () => void;
  onTour?: () => void;
  onLayout?: (l: Layout) => void;
  children?: ReactNode;
};

type View = { k: number; x: number; y: number };

const GRID = 128;
const PAD = 24;
const MAX_K = 40;
// Zoom bands for the three label levels (scent families, neighbourhoods, finer neighbourhoods).
const FAMILY_MAX_K = 2.5;
const FINE_MIN_K = 2.2;
const NO_OWNED = new Set<number>();

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Points live in [0,1]² for both layouts. Screen = PAD + coord * side * k + offset. */
export default function MapView(props: Props) {
  const { map, ix, theme, layout, selected, highlight, camera, compact } = props;
  const owned = props.owned ?? NO_OWNED;
  const preview = props.preview ?? null;
  const insetBottom = props.insetBottom ?? 0;
  const interactive = props.interactive ?? true;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 600 });
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<{ i: number; sx: number; sy: number } | null>(null);
  const [pulse, setPulse] = useState(0); // 0..1 progress of the "you are here" ring, 0 = off
  const [mix, setMix] = useState(layout === "axes" ? 1 : 0); // 0 = islands, 1 = axes
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const touches = useRef(new Map<number, readonly [number, number]>());
  const pinch = useRef(0);
  const anim = useRef(0);
  const morph = useRef(0);
  const P = ix?.c.perfumes;
  const names = useMemo(() => new Map(map.famous), [map]);
  const nameOf = (i: number) => P?.name[i] ?? props.labels?.[i] ?? names.get(i) ?? "";

  // Morph between layouts: every dot glides from its island to its place on the axes.
  useEffect(() => {
    const target = layout === "axes" ? 1 : 0;
    cancelAnimationFrame(morph.current);
    const from = mix;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 1100);
      setMix(from + (target - from) * ease(t));
      if (t < 1) morph.current = requestAnimationFrame(step);
    };
    morph.current = requestAnimationFrame(step);
  }, [layout]);

  const { px, py } = useMemo(() => {
    if (mix === 0) return { px: map.x, py: map.y };
    if (mix === 1) return { px: map.ax, py: map.ay };
    const px = new Float32Array(map.n);
    const py = new Float32Array(map.n);
    for (let i = 0; i < map.n; i++) {
      px[i] = map.x[i] + (map.ax[i] - map.x[i]) * mix;
      py[i] = map.y[i] + (map.ay[i] - map.y[i]) * mix;
    }
    return { px, py };
  }, [map, mix]);

  const settled = mix === 0 || mix === 1;
  const grid = useMemo(() => {
    if (!settled) return null;
    const cells: number[][] = Array.from({ length: GRID * GRID }, () => []);
    for (let i = 0; i < map.n; i++) {
      const gx = Math.min(GRID - 1, Math.floor(px[i] * GRID));
      const gy = Math.min(GRID - 1, Math.floor(py[i] * GRID));
      cells[gy * GRID + gx].push(i);
    }
    return cells;
  }, [map, px, py, settled]);

  const nn = useMemo(() => (ix && selected != null ? neighbours(ix, selected).map((n) => n.id) : []), [ix, selected]);

  const side = Math.min(size.w, size.h) - PAD * 2;
  const ox = (size.w - side) / 2;
  const oy = (size.h - side) / 2;
  const toScreen = (i: number, v: View = view): [number, number] => [
    ox + px[i] * side * v.k + v.x,
    oy + (1 - py[i]) * side * v.k + v.y,
  ];
  const dataToScreen = (x: number, y: number): [number, number] => [
    ox + x * side * view.k + view.x,
    oy + (1 - y) * side * view.k + view.y,
  ];
  /** View that puts data point (x, y-down) at the centre of the visible area at zoom k. */
  const viewFor = (cx: number, cy: number, k: number): View => ({
    k,
    x: size.w / 2 - ox - cx * side * k,
    y: (size.h - insetBottom) / 2 - oy - cy * side * k,
  });

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const animateTo = (target: View, then?: () => void) => {
    cancelAnimationFrame(anim.current);
    const from = view;
    const vis = (size.h - insetBottom) / 2;
    // Interpolate the centre in data space and zoom on a log scale, so the move reads as one glide.
    const centre = (v: View) => [(size.w / 2 - ox - v.x) / (side * v.k), (vis - oy - v.y) / (side * v.k)];
    const [ax, ay] = centre(from);
    const [bx, by] = centre(target);
    const t0 = performance.now();
    const dur = 750;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = ease(t);
      const k = Math.exp(Math.log(from.k) + (Math.log(target.k) - Math.log(from.k)) * e);
      setView(viewFor(ax + (bx - ax) * e, ay + (by - ay) * e, k));
      if (t < 1) anim.current = requestAnimationFrame(step);
      else then?.();
    };
    anim.current = requestAnimationFrame(step);
  };

  const startPulse = () => {
    const t0 = performance.now();
    const step = (now: number) => {
      const t = (now - t0) / 1800;
      setPulse(t < 1 ? Math.max(0.001, t) : 0);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  useEffect(() => {
    if (!camera.key) return;
    const to = camera.to;
    if (to === "home") return animateTo(viewFor(0.5, 0.5, 1));
    if (to === "selection") {
      if (selected == null) return;
      // Fit the selection and its closest neighbours on the map. Far-flung neighbours (the
      // layout is approximate) are left out so the zoom stays useful.
      const tx = layout === "axes" ? map.ax : map.x;
      const ty = layout === "axes" ? map.ay : map.y;
      const near = (nn.length ? nn : [selected])
        .map((j) => [j, (tx[j] - tx[selected]) ** 2 + (ty[j] - ty[selected]) ** 2] as const)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 6)
        .map(([j]) => j);
      const ids = [selected, ...near];
      const xs = ids.map((i) => tx[i]);
      const ys = ids.map((i) => 1 - ty[i]);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.01);
      const k = Math.max(3, Math.min(7, 0.35 / span)); // deep enough to separate, shallow enough to keep labels
      return animateTo(viewFor(tx[selected], 1 - ty[selected], k), startPulse);
    }
    animateTo(viewFor(to.x, 1 - to.y, to.k));
  }, [camera.key]);

  useEffect(() => {
    const cv = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv);
    const tierColor = map.tiers.map((_, t) => css.getPropertyValue(`--tier-${t}`).trim());
    const surface = css.getPropertyValue("--surface-1").trim();
    const ink = css.getPropertyValue("--text-primary").trim();
    const ink2 = css.getPropertyValue("--text-secondary").trim();
    const line = css.getPropertyValue("--line").trim();
    const font = css.fontFamily;
    g.clearRect(0, 0, size.w, size.h);

    const haloText = (t: string, x: number, y: number, color: string) => {
      g.lineJoin = "round";
      g.lineWidth = 4;
      g.strokeStyle = surface;
      g.strokeText(t, x, y);
      g.fillStyle = color;
      g.fillText(t, x, y);
    };

    // Axes view: gridlines at each whole step of weight, and a midline for floral vs woody.
    if (mix > 0) {
      g.globalAlpha = mix;
      g.strokeStyle = line;
      g.lineWidth = 1;
      for (let w = 1; w <= 6; w++) {
        const [sx] = dataToScreen((w - 1) / 5, 0);
        g.beginPath();
        g.moveTo(sx, 0);
        g.lineTo(sx, size.h);
        g.stroke();
      }
      const [, my] = dataToScreen(0, 0.5);
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(0, my);
      g.lineTo(size.w, my);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }

    const r0 = 1.35 + 0.55 * Math.log2(view.k + 1);
    const dim = highlight != null || selected != null;
    g.globalAlpha = dim ? 0.2 : 0.85;
    let run = -1;
    g.beginPath();
    for (const i of map.order) {
      const [sx, sy] = toScreen(i);
      if (sx < -6 || sy < -6 || sx > size.w + 6 || sy > size.h + 6) continue;
      if (map.tier[i] !== run) {
        g.fill();
        g.beginPath();
        run = map.tier[i];
        g.fillStyle = tierColor[run];
      }
      const r = r0 * map.grow[i];
      g.moveTo(sx + r, sy);
      g.arc(sx, sy, r, 0, Math.PI * 2);
    }
    g.fill();
    g.globalAlpha = 1;

    const dot = (i: number, rad: number) => {
      const [sx, sy] = toScreen(i);
      g.beginPath();
      g.arc(sx, sy, rad + 2, 0, Math.PI * 2);
      g.fillStyle = surface;
      g.fill();
      g.beginPath();
      g.arc(sx, sy, rad, 0, Math.PI * 2);
      g.fillStyle = tierColor[map.tier[i]];
      g.fill();
    };

    if (highlight) for (const i of highlight) dot(i, Math.max(2.5, r0 * map.grow[i]));

    for (const i of owned) {
      const [sx, sy] = toScreen(i);
      g.beginPath();
      g.arc(sx, sy, 6, 0, Math.PI * 2);
      g.lineWidth = 2;
      g.strokeStyle = ink;
      g.stroke();
    }

    // Labels. Each claims a box; anything that would overlap an earlier box is skipped, so the
    // order below is the priority: selection, axes, scent families, neighbourhoods, famous bottles.
    const taken: [number, number, number, number][] = [];
    const free = (x: number, y: number, w: number, h: number) => {
      if (x < 4 || y < 4 || x + w > size.w - 4 || y + h > size.h - 4 - insetBottom) return false;
      if (taken.some(([a, b, c, d]) => x < a + c && x + w > a && y < b + d && y + h > b)) return false;
      taken.push([x, y, w, h]);
      return true;
    };
    if (selected != null) {
      for (const j of [selected, ...nn]) {
        const [sx, sy] = toScreen(j);
        taken.push([sx - 8, sy - 8, 16, 16]);
      }
      const [cx, cy] = toScreen(selected);
      g.font = `600 14px ${font}`;
      taken.push([cx + 10, cy - 10, g.measureText(nameOf(selected)).width + 12, 20]);
    }

    if (mix > 0.5) {
      // Axis labels ride with the data, so they stay true while zooming and panning.
      const a = (mix - 0.5) * 2;
      // Along the top, below any overlays: the bottom edge belongs to the zoom controls. Phones
      // drop the title; the shade key already says light and heavy.
      const insetTop = props.insetTop ?? 0;
      const tickY = insetTop + (compact ? 8 : 28);
      g.globalAlpha = a;
      g.textBaseline = "top";
      g.textAlign = "center";
      if (!compact) {
        g.font = `700 12px ${font}`;
        g.letterSpacing = "0.08em";
        const title = "LIGHT & FRESH  →  HEAVY & WARM";
        const tw = g.measureText(title).width + 8;
        if (free(size.w / 2 - tw / 2, insetTop + 8, tw, 16)) haloText(title, size.w / 2, insetTop + 8, ink);
        g.letterSpacing = "0px";
      }
      g.font = `600 ${compact ? 10 : 11}px ${font}`;
      // Words, not scent families: "floral" and "woody" belong to the other axis.
      const short = ["Lightest", "Light", "Medium", "Medium-heavy", "Heavy", "Heaviest"];
      for (let w = 1; w <= 6; w++) {
        const [sx] = dataToScreen((w - 1) / 5, 0);
        const t = short[w - 1];
        const tw = g.measureText(t).width + 6;
        if (free(sx - tw / 2, tickY, tw, 14)) haloText(t, sx, tickY, ink2);
      }
      const bottom = size.h - insetBottom - 60;
      g.textAlign = "left";
      g.font = `700 ${compact ? 11 : 12}px ${font}`;
      const [, top] = dataToScreen(0, 1);
      const [, mid] = dataToScreen(0, 0.5);
      const [, low] = dataToScreen(0, 0);
      const left = 10;
      for (const [t, y] of [
        ["↑ MORE FLORAL", Math.max(top, tickY + 22)],
        ["NEITHER", mid - 18],
        ["↓ MORE WOODY", Math.min(low - 16, bottom - 22)],
      ] as const) {
        const tw = g.measureText(t).width + 8;
        if (free(left - 2, y, tw, 16)) haloText(t, left, y, ink);
      }
      g.globalAlpha = 1;
    }

    const regionAt = (x: number, y: number) =>
      [ox + x * side * view.k + view.x, oy + (1 - y) * side * view.k + view.y] as const;
    const islands = 1 - mix;
    g.textBaseline = "top";
    g.textAlign = "center";
    if (islands > 0.5 && view.k < FAMILY_MAX_K) {
      // Scent families: big, quiet, uppercase, like region names on a printed map.
      g.font = `700 ${compact ? 13 : 16}px ${font}`;
      g.letterSpacing = "0.12em";
      const fade = Math.min(1, (FAMILY_MAX_K - view.k) / 0.6) * (islands - 0.5) * 2;
      for (const reg of map.regions) {
        if (reg.level !== 0) continue;
        const [sx, sy] = regionAt(reg.x, reg.y);
        const t = reg.label.toUpperCase();
        const w = g.measureText(t).width + 10;
        if (!free(sx - w / 2, sy - 30, w, 22)) continue;
        g.globalAlpha = (dim ? 0.3 : 0.62) * fade;
        haloText(t, sx, sy - 28, ink2);
      }
      g.letterSpacing = "0px";
    }
    if (islands > 0.5) {
      g.globalAlpha = (dim ? 0.45 : 1) * (islands - 0.5) * 2;
      for (const level of [1, 2]) {
        if (level === 2 && view.k < FINE_MIN_K) continue;
        for (const reg of map.regions) {
          if (reg.level !== level) continue;
          const [sx, sy] = regionAt(reg.x, reg.y);
          const sub = `like ${reg.exampleName}`;
          g.font = `600 13px ${font}`;
          const w1 = g.measureText(reg.label).width;
          g.font = `12px ${font}`;
          const w2 = g.measureText(sub).width;
          const w = Math.max(w1, w2) + 8;
          if (!free(sx - w / 2, sy - 16, w, 34)) continue;
          g.font = `600 13px ${font}`;
          haloText(reg.label, sx, sy - 14, ink);
          g.font = `12px ${font}`;
          haloText(sub, sx, sy + 2, ink2);
        }
      }
    }
    // Famous bottles: once zoomed in on the islands, and always on the axes, where there are no
    // neighbourhood labels to orient by.
    if (settled && (mix === 1 || view.k >= FINE_MIN_K)) {
      g.globalAlpha = dim ? 0.45 : 1;
      g.textAlign = "left";
      g.font = `12px ${font}`;
      const cap = Math.round((mix === 1 ? 14 : 16) + 6 * Math.log2(view.k));
      let shown = 0;
      for (const [i, name] of map.famous) {
        if (shown >= cap) break;
        const [sx, sy] = toScreen(i);
        const w = g.measureText(name).width + 12;
        if (!free(sx - 4, sy - 8, w, 16)) continue;
        g.beginPath();
        g.arc(sx, sy, 3, 0, Math.PI * 2);
        g.fillStyle = ink;
        g.fill();
        haloText(name, sx + 7, sy - 7, ink);
        shown++;
      }
    }
    g.globalAlpha = 1;

    if (selected != null) {
      const [cx, cy] = toScreen(selected);
      g.lineWidth = 1;
      g.strokeStyle = ink2;
      g.globalAlpha = 0.6;
      for (const j of nn) {
        const [sx, sy] = toScreen(j);
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(sx, sy);
        g.stroke();
      }
      g.globalAlpha = 1;
      for (const j of nn) dot(j, 4);
      dot(selected, 7);
      g.beginPath();
      g.arc(cx, cy, 11, 0, Math.PI * 2);
      g.lineWidth = 2;
      g.strokeStyle = ink;
      g.stroke();
      if (pulse > 0) {
        // Two expanding rings: "you are here" after a search lands.
        for (const off of [0, 0.35]) {
          const t = (pulse * 1.35 - off) % 1;
          if (t <= 0) continue;
          g.beginPath();
          g.arc(cx, cy, 11 + 34 * t, 0, Math.PI * 2);
          g.globalAlpha = 1 - t;
          g.lineWidth = 2;
          g.strokeStyle = ink;
          g.stroke();
        }
        g.globalAlpha = 1;
      }
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.font = `600 14px ${font}`;
      haloText(nameOf(selected), cx + 16, cy, ink);
    }

    if (preview != null && preview !== selected) {
      const [qx, qy0] = toScreen(preview);
      // A clone can sit exactly under the selection; drop its label a line so both read.
      const [cx, cy] = selected != null ? toScreen(selected) : [Infinity, Infinity];
      const qy = Math.hypot(qx - cx, qy0 - cy) < 12 ? qy0 + 20 : qy0;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.arc(qx, qy0, 10, 0, Math.PI * 2);
      g.lineWidth = 2;
      g.strokeStyle = ink;
      g.stroke();
      g.setLineDash([]);
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.font = `600 13px ${font}`;
      haloText(nameOf(preview), qx + 14, qy, ink);
    }
  }, [map, ix, px, py, size, view, selected, nn, highlight, owned, preview, pulse, insetBottom, theme, mix]);

  const pick = (sx: number, sy: number): number | null => {
    if (!grid) return null;
    const s = side * view.k;
    const dx = (sx - ox - view.x) / s;
    const dy = 1 - (sy - oy - view.y) / s;
    const reach = (compact ? 16 : 10) / s; // hit radius bigger than the mark, bigger still for fingers
    let best: number | null = null;
    let bd = Infinity;
    const g0x = Math.max(0, Math.floor((dx - reach) * GRID));
    const g1x = Math.min(GRID - 1, Math.floor((dx + reach) * GRID));
    const g0y = Math.max(0, Math.floor((dy - reach) * GRID));
    const g1y = Math.min(GRID - 1, Math.floor((dy + reach) * GRID));
    for (let gy = g0y; gy <= g1y; gy++)
      for (let gx = g0x; gx <= g1x; gx++)
        for (const i of grid[gy * GRID + gx]) {
          // Prefer popular bottles slightly when several dots sit under the pointer.
          const d2 = (px[i] - dx) ** 2 + (py[i] - dy) ** 2;
          if (d2 / map.grow[i] < bd && d2 <= reach * reach) {
            bd = d2 / map.grow[i];
            best = i;
          }
        }
    return best;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const b = canvas.current!.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top] as const;
  };

  const zoomAt = (sx: number, sy: number, f: number) => {
    cancelAnimationFrame(anim.current);
    setView((v) => {
      const k = Math.max(1, Math.min(MAX_K, v.k * f));
      const ratio = k / v.k;
      return { k, x: sx - ox - (sx - ox - v.x) * ratio, y: sy - oy - (sy - oy - v.y) * ratio };
    });
  };

  useEffect(() => {
    if (!interactive) return;
    const cv = canvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  });

  const centreY = (size.h - insetBottom) / 2;
  const pointer = interactive
    ? {
        onPointerDown: (e: PointerEvent<HTMLCanvasElement>) => {
          cancelAnimationFrame(anim.current);
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          touches.current.set(e.pointerId, local(e));
          if (touches.current.size === 2) {
            // Second finger down: switch from panning to pinching.
            drag.current = null;
            const [a, b] = Array.from(touches.current.values());
            pinch.current = Math.hypot(a[0] - b[0], a[1] - b[1]);
            return;
          }
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
        },
        onPointerMove: (e: PointerEvent<HTMLCanvasElement>) => {
          if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, local(e));
          if (touches.current.size === 2 && pinch.current) {
            const [a, b] = Array.from(touches.current.values());
            const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
            zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, dist / pinch.current);
            pinch.current = dist;
            return;
          }
          const d = drag.current;
          if (d) {
            const mx = e.clientX - d.x;
            const my = e.clientY - d.y;
            if (Math.abs(mx) + Math.abs(my) > 4) d.moved = true;
            if (d.moved) {
              setView((v) => ({ ...v, x: d.vx + mx, y: d.vy + my }));
              setHover(null);
              return;
            }
          }
          if (e.pointerType !== "mouse" || !ix) return;
          const [sx, sy] = local(e);
          const i = pick(sx, sy);
          setHover(i == null ? null : { i, sx, sy });
        },
        onPointerUp: (e: PointerEvent<HTMLCanvasElement>) => {
          touches.current.delete(e.pointerId);
          if (pinch.current) {
            if (touches.current.size === 0) pinch.current = 0;
            drag.current = null;
            return;
          }
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            const [sx, sy] = local(e);
            const i = pick(sx, sy);
            if (i != null) props.onSelect?.(i);
          }
        },
        onPointerCancel: (e: PointerEvent<HTMLCanvasElement>) => {
          touches.current.delete(e.pointerId);
          if (touches.current.size === 0) pinch.current = 0;
          drag.current = null;
        },
        onPointerLeave: () => setHover(null),
        onDoubleClick: (e: MouseEvent<HTMLCanvasElement>) => {
          const [sx, sy] = local(e);
          zoomAt(sx, sy, 2);
        },
      }
    : {};

  return (
    <div className="map" ref={wrap}>
      <canvas
        ref={canvas}
        style={{ width: size.w, height: size.h }}
        role="img"
        aria-label={
          layout === "axes"
            ? `${map.n.toLocaleString()} perfumes plotted from light to heavy, left to right, and from woody to floral, bottom to top`
            : `Map of ${map.n.toLocaleString()} perfumes laid out by shared ingredients, shaded from light to heavy`
        }
        className={hover ? "is-pointing" : undefined}
        {...pointer}
      />
      {hover && P && (
        <div
          className="tip"
          style={{
            left: Math.min(hover.sx + 14, size.w - 230),
            top: hover.sy + 14 > size.h - 80 ? hover.sy - 74 : hover.sy + 14,
          }}
        >
          <div className="tip-name">{P.name[hover.i]}</div>
          <div className="tip-sub">
            {P.brand[hover.i]}
            {P.year[hover.i] ? ` · ${P.year[hover.i]}` : ""} · {P.votes[hover.i].toLocaleString()} ratings
          </div>
          <div className="tip-tier">
            <span className="sw" style={{ background: `var(--tier-${map.tier[hover.i]})` }} />
            {map.tiers[map.tier[hover.i]]}
          </div>
        </div>
      )}
      {props.children}
      {interactive && (
        <>
          {!compact && <p className="map-hint">Scroll to zoom · Drag to move · Click a dot · Bigger dots are more popular</p>}
          <div className="layout-toggle" role="radiogroup" aria-label="Map layout">
            <button role="radio" aria-checked={layout === "islands"} onClick={() => props.onLayout?.("islands")}>
              Islands
            </button>
            <button role="radio" aria-checked={layout === "axes"} onClick={() => props.onLayout?.("axes")}>
              Light ↔ heavy
            </button>
          </div>
          <div className="map-controls" style={{ bottom: insetBottom + 12 }}>
            <button className="tour-btn" onClick={props.onTour}>
              {compact ? "Tour" : "Why is it shaped like this?"}
            </button>
            <button onClick={props.onHelp} aria-label="How to read this map">
              ?
            </button>
            <button onClick={() => zoomAt(size.w / 2, centreY, 1.6)} aria-label="Zoom in">
              +
            </button>
            <button onClick={() => zoomAt(size.w / 2, centreY, 1 / 1.6)} aria-label="Zoom out">
              −
            </button>
            <button onClick={() => animateTo(viewFor(0.5, 0.5, 1))} aria-label="Show the whole map">
              ⤢
            </button>
          </div>
        </>
      )}
    </div>
  );
}
