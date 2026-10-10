import { useMemo } from "react";
import {
  blindBuy,
  budgetAlternative,
  fold,
  fragranticaUrl,
  genderLabel,
  neighbours,
  priceBand,
  priceOf,
  sharedNotes,
  shopLinks,
  size,
  usd,
  type Index,
} from "./data";

/** Plain words for the six evaporation tiers, lightest first. */
export const WEIGHT_WORDS = ["Lightest", "Light", "Medium", "Medium-heavy", "Heavy", "Heaviest"];

type Props = {
  ix: Index;
  i: number;
  onSelect: (i: number) => void;
  owned: Set<number>;
  onOwn: (i: number) => void;
  onLocate: () => void;
};

export default function Detail({ ix, i, onSelect, owned, onOwn, onLocate }: Props) {
  const P = ix.c.perfumes;
  const N = ix.c.notes;
  const verdict = useMemo(() => blindBuy(ix, i, owned), [ix, i, owned]);
  const cheaper = useMemo(() => budgetAlternative(ix, i), [ix, i]);
  const links = shopLinks(ix, i);
  const band = priceBand(ix, i);
  const cheaperBand = cheaper ? priceBand(ix, cheaper.id) : null;
  const meta = [P.year[i], genderLabel(ix, i), ix.c.countries[P.country[i]]].filter(Boolean).join(" · ");
  const nn = neighbours(ix, i);
  const tier = P.tier[i];
  const layers: [string, string, number[]][] = [
    ["First impression", "the first 15 minutes or so", P.top[i]],
    ["Heart", "from about 20 minutes to a few hours", P.middle[i]],
    ["What stays", "the base that lingers for hours", P.base[i]],
  ];

  return (
    <article className="detail">
      <header>
        <h2>{P.name[i]}</h2>
        <p className="d-brand">
          {P.brand[i]}
          {ix.budget.has(i) && <span className="tag">Affordable house</span>}
        </p>
        <p className="d-meta">
          {meta}
          {P.perfumers[i].length > 0 && <> · by {P.perfumers[i].join(" & ")}</>}
        </p>
        {band && (
          <p className="d-price">
            <span className="price-sym" title={`${band.label}: about ${usd(band.perMl * 100)} per 100 ml`}>
              {band.sym}
            </span>{" "}
            {band.label} · about {usd(band.basis.usd)} for {band.basis.ml} ml
          </p>
        )}
        <div className="d-actions">
          <button className={owned.has(i) ? "own is-on" : "own"} onClick={() => onOwn(i)} aria-pressed={owned.has(i)}>
            {owned.has(i) ? "✓ On your shelf" : "I own this"}
          </button>
          <button className="own" onClick={onLocate}>
            Show on map
          </button>
        </div>
      </header>

      <section>
        <h3>What it smells like</h3>
        <div className="chips">
          {P.accords[i].slice(0, 6).map((a) => (
            <span key={a} className="chip static">
              {ix.c.accords[a]}
            </span>
          ))}
        </div>
        <p className="hint">Strongest first, as voted by people who wear it.</p>
      </section>

      <Cost ix={ix} i={i} searchUrl={links.bottles[0].url} />

      <section className="evap" aria-label="How light or heavy it is">
        <h3>Light or heavy?</h3>
        <div className="evap-track">
          {ix.c.tiers.map((t, k) => (
            <span key={t} className={k === tier ? "on" : ""} style={{ background: `var(--tier-${k})` }} title={t} />
          ))}
        </div>
        <div className="evap-ends">
          <span>Light & fresh</span>
          <span>Heavy & warm</span>
        </div>
        <p>
          <strong>{WEIGHT_WORDS[tier]}</strong> ({ix.c.tiers[tier].toLowerCase()}).{" "}
          {tier <= 1
            ? "Light scents feel fresh and fade sooner."
            : tier >= 4
              ? "Heavy scents sit close and last longer."
              : "Somewhere in the middle."}{" "}
          Testing several in a store? Smell the lighter ones first, because heavy scents linger in your nose.
        </p>
      </section>

      <section className={`verdict is-${verdict.level}`} aria-label="Blind buy check">
        <h3>Should you buy it without smelling it?</h3>
        <p className="verdict-head">{verdict.headline}</p>
        <ul>
          {verdict.reasons.map((r) => (
            <li key={r.text} className={`reason is-${r.tone}`}>
              <span aria-hidden="true">{r.tone === "good" ? "✓" : r.tone === "bad" ? "!" : "·"}</span>
              {r.text}
            </li>
          ))}
        </ul>
        <p className="hint">A rule of thumb from ratings and scent type, not a promise. Perfume smells different on every skin.</p>
      </section>

      <section className="buy" aria-label="Try it or buy it">
        <h3>Try it or buy it</h3>
        {cheaper && (
          <div className="cheaper">
            <p>
              <strong>Cheaper route:</strong>{" "}
              <button className="link" onClick={() => onSelect(cheaper.id)}>
                {P.name[cheaper.id]}
              </button>{" "}
              by {P.brand[cheaper.id]}, an affordable house, is {Math.round(cheaper.sim * 100)}% alike on paper
              {cheaperBand && band ? (
                <>
                  {" "}
                  and costs about {usd(cheaperBand.perMl * 100)} per 100 ml ({cheaperBand.basis.src}) against{" "}
                  {usd(band.perMl * 100)} for this one ({band.basis.src})
                </>
              ) : cheaperBand ? (
                <>
                  {" "}
                  and costs about {usd(cheaperBand.basis.usd)} for {cheaperBand.basis.ml} ml ({cheaperBand.basis.src})
                </>
              ) : null}
              . Same listed notes doesn't mean the same quality, so sample both if you can.
            </p>
          </div>
        )}
        <p className="buy-step">
          <strong>1. Get a sample</strong> <span className="hint-inline">a 2 ml vial is about 20 sprays, enough for a week of testing</span>
        </p>
        <div className="links">
          {links.samples.map((l) => (
            <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className="shop">
              {l.label}
              <span>{l.note}</span>
            </a>
          ))}
        </div>
        <p className="buy-step">
          <strong>2. Buy the bottle</strong> <span className="hint-inline">once you know you like it</span>
        </p>
        <div className="links">
          {links.bottles.map((l) => (
            <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className={l.label === "Compare prices" ? "shop primary" : "shop"}>
              {l.label}
              {l.note && <span>{l.note}</span>}
            </a>
          ))}
        </div>
        <p className="hint">
          Nose Map doesn't track live prices or stock. These links open a live search on each site, so what you see
          there is current. Not affiliate links.
        </p>
      </section>

      <section>
        <h3>Smells similar</h3>
        <ol className="nn">
          {nn.map(({ id: j, sim }) => {
            const shared = sharedNotes(ix, i, j);
            const pct = Math.round(sim * 100);
            const jb = priceBand(ix, j);
            return (
              <li key={j}>
                <button onClick={() => onSelect(j)}>
                  <span className="sim" aria-label={`${pct} percent alike`}>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  <span className="nn-text">
                    <span className="r-name">{P.name[j]}</span>
                    <span className="r-sub">
                      {P.brand[j]} · {pct}% alike · {shared.length} shared ingredient{shared.length === 1 ? "" : "s"}
                      {jb ? ` · ${jb.sym}` : ""}
                      {ix.budget.has(j) && !ix.budget.has(i) ? " · affordable" : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {nn[0] && nn[0].sim >= 0.95 && fold(P.brand[nn[0].id]) !== fold(P.brand[i]) && (
          <p className="note">
            When another brand lists almost the same ingredients, it is usually a clone or an "inspired by" scent.
          </p>
        )}
      </section>

      <section className="pyramid">
        <h3>How it changes on your skin</h3>
        {layers.map(([label, when, ids]) =>
          ids.length ? (
            <div key={label} className="layer">
              <p className="layer-head">
                <strong>{label}</strong> <span className="hint-inline">{when}</span>
              </p>
              <div className="chips">
                {ids.map((j) => (
                  <span key={j} className="chip static">
                    {N[j]}
                  </span>
                ))}
              </div>
            </div>
          ) : null
        )}
      </section>

      <p className="d-meta">
        {P.rating[i] != null && (
          <>
            Rated {P.rating[i]!.toFixed(2)} out of 5 by {P.votes[i].toLocaleString()} people on Fragrantica ·{" "}
          </>
        )}
        <a href={fragranticaUrl(ix, i)} target="_blank" rel="noreferrer">
          Read reviews
        </a>
      </p>
    </article>
  );
}

/** What the bottle cost in the two price snapshots, or what its house usually costs. */
function Cost({ ix, i, searchUrl }: { ix: Index; i: number; searchUrl: string }) {
  const P = ix.c.perfumes;
  const { retail, street } = priceOf(ix, i);
  const band = priceBand(ix, i);
  const house = ix.c.brandPrices[P.brand[i]];
  return (
    <section className="cost" aria-label="What it costs">
      <h3>What it costs</h3>
      {retail && (
        <div className="price-row">
          <span className="price-big">{usd(retail.usd)}</span>
          <span>
            {retail.ml ? <>for {size(retail.ml)} </> : null}at {retail.src} (list price, {retail.date})
            <span className="hint-inline">
              {" "}
              Listed as “{retail.title}”
              {retail.lo != null && retail.hi != null && retail.hi > retail.lo
                ? `; other sizes ${usd(retail.lo)}–${usd(retail.hi)}`
                : ""}
              .
            </span>
          </span>
        </div>
      )}
      {street && (
        <div className="price-row">
          <span className="price-big">{usd(street.usd)}</span>
          <span>
            {street.ml ? <>for {size(street.ml)} </> : null}on {street.src} (typical asking price
            {street.n && street.n > 1 ? ` across ${street.n} listings` : ", one listing"}, {street.date})
            <span className="hint-inline"> Often cheaper than stores, but fakes are common, so check the seller.</span>
          </span>
        </div>
      )}
      {band && (
        <p className="per-spray">
          Works out to about <strong>{Math.max(1, Math.round(band.perMl * 10))}¢ a spray</strong>, counting a spray as
          roughly 0.1 ml.
        </p>
      )}
      {!retail && !street && (
        <p className="price-none">
          {house ? (
            <>
              No price for this exact bottle yet. Other {P.brand[i]} perfumes cost {usd(house.lo)}–{usd(house.hi)}{" "}
              {house.src === "eBay" ? "on" : "at"} {house.src} ({house.date}).
            </>
          ) : (
            <>No price for this one in our data yet.</>
          )}
        </p>
      )}
      <p className="hint">
        These are dated snapshots from public datasets, so today's price will differ.{" "}
        <a href={searchUrl} target="_blank" rel="noreferrer">
          Check today's prices
        </a>
      </p>
    </section>
  );
}
