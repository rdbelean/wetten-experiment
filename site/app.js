/* Projekt Value – Dashboard. Liest data/state.json (von GitHub Actions geschrieben)
   und Live-Stände direkt von der öffentlichen ESPN-Scoreboard-API. */
(() => {
  "use strict";
  const TZ = "Europe/Berlin";
  const DUR = { "Fußball": 2.0, "Basketball": 2.75, "Eishockey": 3.0, "American Football": 3.75 };
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const nf2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const eur = (n, sign) => (n == null ? "–" : (sign && n > 0 ? "+" : n < 0 ? "−" : "") + nf2.format(Math.abs(n)) + " €");
  const eur0 = (n) => (Number.isInteger(n) ? n.toLocaleString("de-DE") : nf2.format(n)) + " €";
  const pct = (x, sign) => (x == null ? "–" : (sign && x > 0 ? "+" : x < 0 ? "−" : "") + nf1.format(Math.abs(x * 100)) + " %");
  const odds = (o) => (o == null ? "–" : nf2.format(o));
  const fmt = (iso, opts) => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, ...opts }).format(new Date(iso));
  const hhmm = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
  const wd = (iso) => fmt(iso, { weekday: "short" }).replace(".", "");
  const berlinDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

  let state = null;
  let selectedDay = null;
  const open = new Set();
  const live = {}; // betId -> {home_score, away_score, detail, status}

  // ------------------------------------------------------------------ Daten laden
  async function load() {
    try {
      const r = await fetch(`data/state.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      state = await r.json();
      render();
      pollLive();
    } catch (e) {
      $("topStatus").textContent = "Daten konnten nicht geladen werden. Die Seite versucht es in einer Minute erneut.";
    }
  }

  const liveBets = () => {
    const now = Date.now();
    return (state?.bets || []).filter((b) => {
      if (b.status !== "open" || !b.espn) return false;
      const t = new Date(b.commence).getTime();
      return now >= t - 5 * 60e3 && now <= t + ((DUR[b.group] || 2.5) + 1.5) * 3600e3;
    });
  };

  async function pollLive() {
    const bets = liveBets();
    if (!bets.length) { renderLive(); return; }
    const want = new Map();
    for (const b of bets) {
      const t = new Date(b.commence);
      for (const h of [-8, 0]) {
        const d = new Date(t.getTime() + h * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
        want.set(`${b.espn.path}|${d}`, [b.espn.path, d]);
      }
    }
    const events = {};
    await Promise.all([...want.values()].map(async ([path, d]) => {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${d}`);
        const j = await r.json();
        for (const e of j.events || []) events[e.id] = e;
      } catch (_) { /* nächster Versuch beim nächsten Poll */ }
    }));
    for (const b of bets) {
      const e = events[b.espn.id];
      if (!e) continue;
      const c = e.competitions[0];
      const side = (ha) => c.competitors.find((x) => x.homeAway === ha);
      live[b.id] = {
        home_score: +side("home").score || 0, away_score: +side("away").score || 0,
        detail: e.status.type.shortDetail, state: e.status.type.state, // pre | in | post
      };
    }
    renderLive();
    renderSlips();
    renderTop();
  }

  // ------------------------------------------------------------------ Hilfen Wetten
  function grade(b, hs, as) {
    const k = b.key, pt = b.point;
    if (b.market === "h2h") { const r = hs > as ? "home" : as > hs ? "away" : "draw"; return r === k ? "won" : "lost"; }
    if (b.market === "totals") { const t = hs + as; if (t === pt) return "push"; return (t > pt) === (k === "over") ? "won" : "lost"; }
    if (b.market === "spreads") { const m = hs - as + pt; if (m === 0) return "push"; return (m > 0) === (k === "home") ? "won" : "lost"; }
    return null;
  }

  function stamp(b) {
    const lv = live[b.id];
    if (b.status === "won") return `<span class="stamp st-won">Gewonnen<small>${eur(b.profit, true)}</small></span>`;
    if (b.status === "lost") return `<span class="stamp st-lost">Verloren<small>${eur(b.profit, true)}</small></span>`;
    if (b.status === "push" || b.status === "void") return `<span class="stamp st-push">${b.status === "push" ? "Push" : "Abgesagt"}<small>Einsatz zurück</small></span>`;
    if (lv && lv.state === "in") return `<span class="stamp st-live">Live ${lv.home_score}:${lv.away_score}<small>${esc(lv.detail)}</small></span>`;
    if (lv && lv.state === "post") return `<span class="stamp st-open">Wird abgerechnet<small>${lv.home_score}:${lv.away_score}</small></span>`;
    const t = new Date(b.commence).getTime();
    const mins = Math.round((t - Date.now()) / 60000);
    const when = mins > 0 && mins < 180 ? `in ${mins >= 60 ? Math.floor(mins / 60) + " h " : ""}${mins % 60} min` : `${wd(b.commence)} ${hhmm(b.commence)}`;
    return `<span class="stamp st-open">Offen<small>${when}</small></span>`;
  }

  // ------------------------------------------------------------------ Render
  function render() {
    renderTop();
    renderHero();
    renderChart();
    renderDays();
    renderSlips();
    renderSkill();
    renderMethod();
    renderSys();
  }

  function dayIndex() {
    const today = berlinDate();
    const i = state.days.findIndex((d) => d.date === today);
    return i;
  }

  function renderTop() {
    if (!state) return;
    const i = dayIndex();
    const lv = Object.entries(live).filter(([id, v]) => v.state === "in" && state.bets.find((b) => b.id === id && b.status === "open")).length;
    const upd = hhmm(state.generated_at);
    let txt;
    if (i >= 0) txt = `Tag ${i + 1} von ${state.experiment.days}`;
    else if (berlinDate() < state.days[0].date) txt = `Start am ${fmt(state.days[0].date + "T12:00:00", { weekday: "long", day: "numeric", month: "long" })}`;
    else txt = "Experiment beendet";
    $("topStatus").innerHTML = `<span class="dot ${lv ? "is-live" : ""}"></span>${txt}${lv ? `, ${lv} ${lv === 1 ? "Spiel" : "Spiele"} live` : ""}, aktualisiert ${upd} Uhr`;
  }

  function renderHero() {
    const t = state.totals;
    const settled = t.won + t.lost + t.push;
    const bal = $("balance");
    bal.className = "balance" + (t.profit > 0.004 ? " pos" : t.profit < -0.004 ? " neg" : "");
    const sign = t.profit > 0.004 ? "+" : t.profit < -0.004 ? "−" : "";
    bal.innerHTML = `${sign}${nf2.format(Math.abs(t.profit))}<span class="cur">€</span>`;
    $("heroKicker").textContent = settled ? `Gewinn nach ${settled} abgerechneten ${settled === 1 ? "Wette" : "Wetten"}` : "Noch keine Wette abgerechnet";
    const total = state.experiment.total_budget;
    let line = `${eur0(total)} Spielgeld, ${state.experiment.days} Tage, jeden Tag genau ${eur0(state.experiment.daily_budget)} gesetzt.`;
    if (t.staked) line += ` Bisher sind ${eur(t.staked)} im Spiel, ${eur(t.returned)} kamen zurück.`;
    else line += " Die ersten Wetten gehen am Starttag um 11:00 Uhr raus.";
    $("heroLine").textContent = line;
    const facts = [
      ["Gesetzt", eur(t.staked)],
      ["Zurückbekommen", eur(t.returned)],
      ["Rendite", t.roi == null ? "–" : pct(t.roi, true)],
      ["Noch offen", t.open_stake ? `${eur(t.open_stake)}` : "–"],
      ["Trefferquote", t.hit_rate == null ? "–" : `${t.won} von ${t.won + t.lost}`],
      ["Mathematisch erwartet", t.staked_settled ? eur(sumExpSettled(), true) : "–"],
    ];
    $("facts").innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  }

  // ------------------------------------------------------------------ Chart
  function series() {
    const done = state.bets.filter((b) => b.status !== "open")
      .sort((a, b) => (a.result?.t || a.commence).localeCompare(b.result?.t || b.commence) || a.commence.localeCompare(b.commence));
    const pts = [{ i: 0, real: 0, exp: 0, bet: null }];
    let r = 0, e = 0;
    done.forEach((b, i) => { r += b.profit || 0; e += (b.ev || 0) * b.stake; pts.push({ i: i + 1, real: r, exp: e, bet: b }); });
    return pts;
  }

  function renderChart() {
    const box = $("chart");
    const pts = series();
    box.innerHTML = "";
    if (pts.length < 2) {
      box.innerHTML = `<div class="chart-empty">Sobald die erste Wette abgerechnet ist, erscheint hier die Kurve: der echte Kontostand gegen den Gewinn, den die Mathematik im Schnitt erwarten würde.</div>`;
      $("chartTable").innerHTML = "";
      return;
    }
    const W = box.clientWidth || 600, H = box.clientHeight || 260;
    const m = { l: 52, r: 74, t: 10, b: 26 };
    const vals = pts.flatMap((p) => [p.real, p.exp]);
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const span = hi - lo || 10;
    const step = niceStep(span / 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const n = pts.length - 1;
    const x = (i) => m.l + (i / n) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    let g = `<g class="grid">`;
    for (let v = lo; v <= hi + 1e-9; v += step) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `</g><g class="axis">`;
    for (let v = lo; v <= hi + 1e-9; v += step) g += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${(v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v))} €</text>`;
    // Tages-Marken an der x-Achse
    let lastDay = null;
    pts.forEach((p) => {
      if (!p.bet || p.bet.day === lastDay) return;
      lastDay = p.bet.day;
      g += `<text x="${x(p.i)}" y="${H - 6}" text-anchor="middle">${wd(p.bet.day + "T12:00:00")}</text>`;
    });
    g += `</g>`;
    const path = (k) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
    const area = `${path("real")}L${x(n)},${y(0)}L${x(0)},${y(0)}Z`;
    const last = pts[n];
    const labY = labelPositions(y(last.real), y(last.exp), 16);
    svg.innerHTML = `${g}
      <line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>
      <path class="area" d="${area}"/>
      <path class="exp" d="${path("exp")}"/>
      <path class="real" d="${path("real")}"/>
      <circle cx="${x(n)}" cy="${y(last.exp)}" r="4" fill="var(--ochre)" class="hoverdot"/>
      <circle cx="${x(n)}" cy="${y(last.real)}" r="4.5" fill="var(--pen)" class="hoverdot"/>
      <text class="endlabel" x="${x(n) + 10}" y="${labY[0] + 4}">${eur(last.real, true)}</text>
      <text class="endlabel" x="${x(n) + 10}" y="${labY[1] + 4}" style="font-weight:500">${eur(last.exp, true)}</text>
      <g class="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${H - m.b}"/>
        <circle r="4" fill="var(--ochre)" class="hoverdot hd-exp"/><circle r="4.5" fill="var(--pen)" class="hoverdot hd-real"/></g>
      <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/>`;
    box.appendChild(svg);
    const tip = el("div", "tip"); tip.hidden = true; box.appendChild(tip);
    const hover = svg.querySelector(".hover");
    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n, Math.round(((px - m.l) / (W - m.l - m.r)) * n)));
      const p = pts[i];
      hover.style.display = "";
      hover.querySelector(".cross").setAttribute("x1", x(i)); hover.querySelector(".cross").setAttribute("x2", x(i));
      const hr = hover.querySelector(".hd-real"), he = hover.querySelector(".hd-exp");
      hr.setAttribute("cx", x(i)); hr.setAttribute("cy", y(p.real)); he.setAttribute("cx", x(i)); he.setAttribute("cy", y(p.exp));
      tip.hidden = false;
      tip.style.left = `${(x(i) / W) * 100}%`; tip.style.top = `${(Math.min(y(p.real), y(p.exp)) / H) * 100}%`;
      tip.innerHTML = p.bet
        ? `Nach Wette ${i}: ${esc(p.bet.home)} – ${esc(p.bet.away)}<br><b>Echt ${eur(p.real, true)}</b>, erwartet ${eur(p.exp, true)}`
        : `Start: 0 €`;
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerleave", () => { hover.style.display = "none"; tip.hidden = true; });
    $("chartTable").innerHTML = `<table><thead><tr><th>Nr.</th><th>Spiel</th><th>Ergebnis</th><th class="num">Echt</th><th class="num">Erwartet</th></tr></thead><tbody>${pts.slice(1).map((p) =>
      `<tr><td>${p.i}</td><td>${esc(p.bet.home)} – ${esc(p.bet.away)}</td><td>${p.bet.status === "won" ? "Gewonnen" : p.bet.status === "lost" ? "Verloren" : "Zurück"}</td><td class="num">${eur(p.real, true)}</td><td class="num">${eur(p.exp, true)}</td></tr>`).join("")}</tbody></table>`;
  }

  function labelPositions(a, b, gap) {
    if (Math.abs(a - b) >= gap) return [a, b];
    const mid = (a + b) / 2;
    return a <= b ? [mid - gap / 2, mid + gap / 2] : [mid + gap / 2, mid - gap / 2];
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  // ------------------------------------------------------------------ Live-Leiste
  function renderLive() {
    const bets = liveBets().filter((b) => live[b.id] && live[b.id].state === "in");
    $("liveSection").hidden = !bets.length;
    $("liveStrip").innerHTML = bets.map((b) => {
      const lv = live[b.id];
      const g = grade(b, lv.home_score, lv.away_score);
      const trend = g === "won" ? `<span class="trend-win">Stand jetzt: gewonnen</span>` : g === "lost" ? `<span class="trend-loss">Stand jetzt: verloren</span>` : `Stand jetzt: Einsatz zurück`;
      return `<article class="live-card"><div class="lc-top"><span>${esc(b.league)}</span><span>${esc(lv.detail)}</span></div>
        <div class="lc-score">${lv.home_score} : ${lv.away_score}</div>
        <div class="lc-teams">${esc(b.home)} – ${esc(b.away)}</div>
        <div class="lc-pick">${esc(b.label)} zu ${odds(b.odds)}, ${eur(b.stake)} Einsatz. ${trend}</div></article>`;
    }).join("");
  }

  // ------------------------------------------------------------------ Tage
  function renderDays() {
    const today = berlinDate();
    if (!selectedDay) {
      const withBets = state.days.filter((d) => d.n_bets);
      selectedDay = state.days.find((d) => d.date === today)?.date || withBets.at(-1)?.date || state.days[0].date;
    }
    const box = $("days");
    box.innerHTML = "";
    state.days.forEach((d, i) => {
      const b = el("button", "day" + (d.date === today ? " d-today" : ""));
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", d.date === selectedDay);
      const dt = d.date + "T12:00:00";
      let val, meta;
      if (!d.n_bets) { val = `<span class="d-profit" style="color:var(--ink-3)">–</span>`; meta = d.date < today ? "keine Wetten" : "Wetten ab 11:00"; }
      else {
        const cls = d.profit > 0 ? "d-pos" : d.profit < 0 ? "d-neg" : "";
        val = `<span class="d-profit ${cls}">${d.settled ? eur(d.profit, true) : "offen"}</span>`;
        meta = `${d.n_bets} Wetten, ${d.settled} abgerechnet`;
      }
      b.innerHTML = `<span class="d-name">Tag ${i + 1}</span><span class="d-date">${fmt(dt, { weekday: "short" }).replace(".", "")}, ${fmt(dt, { day: "numeric", month: "short" })}</span>${val}<span class="d-meta">${meta}</span>`;
      b.addEventListener("click", () => { selectedDay = d.date; renderDays(); renderSlips(); });
      box.appendChild(b);
    });
  }

  // ------------------------------------------------------------------ Wettscheine
  function renderSlips() {
    if (!state) return;
    const d = state.days.find((x) => x.date === selectedDay);
    const idx = state.days.indexOf(d);
    const bets = state.bets.filter((b) => b.day === selectedDay).sort((a, b) => a.commence.localeCompare(b.commence));
    $("dayTitle").textContent = `Wetten an Tag ${idx + 1}`;
    const dt = d.date + "T12:00:00";
    let meta = `${fmt(dt, { weekday: "long", day: "numeric", month: "long" })}, Spiele von 12 Uhr bis 12 Uhr am Folgetag.`;
    if (d.n_outcomes) meta += ` Geprüft: ${d.n_outcomes} Wettmöglichkeiten, davon ${d.n_value} mit Vorteil.`;
    $("dayMeta").textContent = meta;
    const box = $("slips");
    box.innerHTML = "";
    if (d.research?.summary) box.appendChild(el("p", "research-note", `<strong>Recherche vor dem Spieltag:</strong> ${esc(d.research.summary)}`));
    if (d.summary?.text) box.appendChild(el("div", "research-note", `<strong>Tagesauswertung:</strong> ${esc(d.summary.text)}${d.summary.lessons ? `<p class="lesson">${esc(d.summary.lessons)}</p>` : ""}`));
    if (!bets.length) {
      const future = d.date >= berlinDate();
      box.appendChild(el("div", "empty", future
        ? `<strong>Für diesen Tag ist noch nichts gesetzt.</strong>Um 8:30 Uhr holt das System die Quoten, danach recherchiert Claude die News. Um 11:00 Uhr werden die 100 € verteilt.`
        : `<strong>An diesem Tag wurden keine Wetten platziert.</strong>`));
    }
    bets.forEach((b) => box.appendChild(slip(b)));
    const near = d.near_misses || [];
    $("nearWrap").hidden = !near.length;
    $("near").innerHTML = near.length ? `<table><thead><tr><th>Spiel</th><th>Wette</th><th class="num">Quote</th><th class="num">Unsere Wkt.</th><th class="num">Vorteil</th></tr></thead><tbody>${near.map((n) =>
      `<tr><td>${esc(n.home)} – ${esc(n.away)}<br><small>${esc(n.league)}, ${wd(n.commence)} ${hhmm(n.commence)}</small></td><td>${esc(n.label)}</td><td class="num">${odds(n.odds)}<br><small>${esc(n.book_name)}</small></td><td class="num">${pct(n.p)}</td><td class="num">${pct(n.ev, true)}</td></tr>`).join("")}</tbody></table>` : "";
  }

  function slip(b) {
    const s = el("article", "slip");
    const row = el("button", "slip-row");
    row.setAttribute("aria-expanded", open.has(b.id));
    row.innerHTML = `
      <div class="s-time">${wd(b.commence)}<b>${hhmm(b.commence)}</b></div>
      <div class="s-main"><div class="s-league">${esc(b.league)}</div><div class="s-match">${esc(b.home)} – ${esc(b.away)}</div>
        <div class="s-pick">${esc(b.label)}${b.kind === "filler" ? `<span class="s-filler">Füllwette</span>` : ""}</div></div>
      <div class="s-odds"><b>${odds(b.odds)}</b><span>${esc(b.book_name)}</span></div>
      <div class="s-stake"><b>${eur0(b.stake)}</b><span>möglich ${eur(b.potential_payout)}</span></div>
      <div class="s-state">${stamp(b)}</div>`;
    const det = el("div", "slip-detail");
    det.hidden = !open.has(b.id);
    det.innerHTML = detail(b);
    row.addEventListener("click", () => {
      open.has(b.id) ? open.delete(b.id) : open.add(b.id);
      row.setAttribute("aria-expanded", open.has(b.id));
      det.hidden = !open.has(b.id);
    });
    s.append(row, det);
    return s;
  }

  function detail(b) {
    const pr = (name, v, cls = "") => v == null ? "" : `<span>${name}</span><span class="pbar ${cls}"><i style="width:${(v * 100).toFixed(1)}%"></i></span><span>${pct(v)}</span>`;
    let res = "";
    if (b.status !== "open") {
      const sc = b.result && b.result.home != null ? `Endstand ${b.result.home}:${b.result.away}. ` : "";
      const st = { won: "Gewonnen", lost: "Verloren", push: "Push, Einsatz zurück", void: "Abgesagt, Einsatz zurück" }[b.status];
      res = `<div class="result-box ${b.status}"><strong>${st}.</strong> ${sc}Auszahlung ${eur(b.payout)}, Ergebnis ${eur(b.profit, true)}.</div>`;
    }
    const clv = b.clv != null ? `<p>Schlusskurs: fair ${odds(b.closing?.fair_odds)}, unsere Quote ${odds(b.odds)}. Closing Line Value <strong>${pct(b.clv, true)}</strong>.</p>` : b.closing?.missed ? `<p>Der Schlusskurs konnte nicht erfasst werden.</p>` : b.status === "open" ? `<p>Der Schlusskurs wird kurz vor Anpfiff erfasst.</p>` : "";
    const an = b.analysis ? `<p>${esc(b.analysis.text)}</p>${b.analysis.lesson ? `<p class="lesson">${esc(b.analysis.lesson)}</p>` : ""}` : b.auto_analysis ? `<p>${esc(b.auto_analysis)}</p>` : "";
    const left = `
      <div><h4>Warum diese Wette</h4><p class="reason">${esc(b.reason)}</p>
      <div class="probs">${pr("Markt (fair)", b.fair_market)}${pr("Tor-Modell", b.model_p)}${pr("Unser Wert", b.p, "p-final")}</div>
      ${res}<div class="analysis">${clv}${an}</div></div>`;
    const entries = Object.entries(b.books || {}).sort((a, c) => c[1] - a[1]);
    const max = entries.length ? entries[0][1] : b.odds;
    const min = entries.length ? entries.at(-1)[1] : b.odds;
    const lo = Math.max(1, min - (max - min) * 0.6 - 0.05);
    const w = (v) => Math.max(2, ((v - lo) / (max - lo)) * 100);
    const fairO = b.fair_market ? 1 / b.fair_market : null;
    const fairPos = fairO ? Math.min(100, Math.max(0, w(fairO))) : null;
    const rows = entries.map(([bk, v]) => {
      const hl = bk === b.book_name || bk === "Tipico" || bk === "Pinnacle";
      return `<span class="bk ${hl ? "hl" : ""}">${esc(bk)}</span><span class="bbar ${bk === b.book_name ? "best" : ""} ${fairPos != null ? "fair" : ""}" style="--fair:${fairPos}%"><i style="width:${w(v)}%"></i></span><span class="bv">${odds(v)}</span>`;
    }).join("");
    const right = `<div><h4>Quotenvergleich für „${esc(b.label)}“</h4><div class="books">${rows}</div>
      <p class="books-note"><span class="fair-key"></span>Faire Quote ${odds(fairO)}. Alles rechts davon ist eine Wette mit Vorteil.${b.tipico_odds ? ` Tipico bot ${odds(b.tipico_odds)}.` : ""}</p></div>`;
    return left + right;
  }

  // ------------------------------------------------------------------ Können/Glück
  function renderSkill() {
    const t = state.totals;
    const items = [
      ["Ø Closing Line Value", t.avg_clv == null ? "–" : pct(t.avg_clv, true), t.n_clv ? `aus ${t.n_clv} erfassten Schlusskursen` : "noch keine Schlusskurse"],
      ["Besser als Schlusskurs", t.n_clv ? `${t.clv_positive} von ${t.n_clv}` : "–", "Anteil Wetten mit Vorteil"],
      ["Ø Erwartungswert", t.avg_ev == null ? "–" : pct(t.avg_ev, true), "beim Platzieren, nach Einsatz gewichtet"],
      ["Echt minus erwartet", t.staked_settled ? eur(t.profit - sumExpSettled(), true) : "–", "positiv heißt: Glück auf unserer Seite"],
    ];
    $("skillStats").innerHTML = items.map(([k, v, s]) => `<div><dt>${k}</dt><dd>${v}<small>${s}</small></dd></div>`).join("");
  }
  const sumExpSettled = () => state.bets.filter((b) => b.status !== "open").reduce((a, b) => a + (b.ev || 0) * b.stake, 0);

  function renderMethod() {
    const r = state.rules;
    if (r) {
      $("mw").textContent = `${Math.round(r.model_weight[1] * 100)}–${Math.round(r.model_weight[2] * 100)} %`;
      $("adjcap").textContent = Math.round(r.adj_cap * 100);
      $("minev").textContent = pct(r.min_ev, true);
    }
    const bt = state.backtest;
    if (!bt) return;
    const svs = bt.sharp_vs_soft?.by_threshold?.["0.02"];
    const ll = (bt.model || []).map((m) => {
      const base = m.logloss["0.0"], best = Object.entries(m.logloss).sort((a, c) => a[1] - c[1])[0];
      return { league: m.league, gain: base - best[1], w: best[0] };
    });
    const names = { D1: "Bundesliga", E0: "Premier League", D2: "2. Bundesliga", E1: "Championship", SP1: "La Liga", I1: "Serie A" };
    $("evidence").innerHTML = `<h3>Was der Backtest zeigt</h3>
      ${svs ? `<p>Die Kernstrategie haben wir an der Saison 2024/25 getestet: Pinnacle-Quote entmargen und bei der besten Quote am Markt wetten, wenn der Vorteil über 2 % liegt. Das ergab in 10 Ligen ${svs.bets} Wetten mit <strong>${pct(svs.roi, true)} Rendite</strong>. Im Schnitt lag die Quote ${pct(svs.clv)} über dem fairen Schlusskurs.</p>` : ""}
      <p>Das Tor-Modell allein hat den Markt in der Saison 2025/26 nicht geschlagen. Den Log-Loss der Pinnacle-Schlussquote verbessert es nur in ${ll.filter((x) => x.gain > 0.0001).map((x) => names[x.league] || x.league).join(", ") || "keiner Liga"}. Deshalb bekommt es nur ein kleines Gewicht. Ehrlich gesagt: Den größten Teil des Vorteils liefert der Quotenvergleich, nicht die eigene Prognose.</p>`;
  }

  function renderSys() {
    const s = state.system || {};
    const parts = [`Stand der Daten: ${fmt(state.generated_at, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} Uhr`];
    if (s.credits_remaining != null) parts.push(`Quoten-API: ${s.credits_remaining} von 500 Abrufen übrig`);
    const la = (s.last_actions || []).at(-1);
    if (la) parts.push(`Letzte Aktion: ${la.a} (${hhmm(la.t)} Uhr)`);
    $("sys").textContent = parts.join(". ") + ".";
  }

  // ------------------------------------------------------------------ Start
  $("tableToggle").addEventListener("click", (e) => {
    const t = $("chartTable"), c = $("chart");
    const show = t.hidden;
    t.hidden = !show; c.hidden = show;
    e.target.setAttribute("aria-expanded", show);
    e.target.textContent = show ? "Als Diagramm" : "Als Tabelle";
  });
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => state && renderChart(), 150); });
  load();
  setInterval(load, 60_000);
  setInterval(() => { if (state && liveBets().length) pollLive(); }, 30_000);
})();
