/* Quotenlabor – Dashboard. Liest data/state.json (von GitHub Actions geschrieben)
   und Live-Stände direkt von der öffentlichen ESPN-Scoreboard-API. */
(() => {
  "use strict";
  const TZ = "Europe/Berlin";
  const DUR = { "Fußball": 2.0, "Basketball": 2.75, "Eishockey": 3.0, "American Football": 3.75 };
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const nf2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const sgn = (n) => (n > 0.004 ? "+" : n < -0.004 ? "−" : "");
  const eur = (n, sign) => (n == null ? "–" : (sign ? sgn(n) : n < -0.004 ? "−" : "") + nf2.format(Math.abs(n)) + " €");
  const eur0 = (n) => (Number.isInteger(n) ? n.toLocaleString("de-DE") : nf2.format(n)) + " €";
  const pct = (x, sign) => (x == null ? "–" : (sign ? sgn(x) : x < 0 ? "−" : "") + nf1.format(Math.abs(x * 100)) + " %");
  const odds = (o) => (o == null ? "–" : nf2.format(o));
  const fmt = (iso, opts) => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, ...opts }).format(new Date(iso));
  const hhmm = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
  const wd = (iso) => fmt(iso, { weekday: "short" }).replace(".", "");
  const berlinDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

  let state = null;
  let selectedDay = null;
  let view = decodeURIComponent(location.hash.slice(1)) || "vergleich";
  const P = () => state.players[view] || state.players.analyst;
  const myBets = () => (view === "vergleich" ? state.bets : state.bets.filter((b) => b.player === P().id));
  const pName = (id) => state.players[id]?.name || id;
  let firstRender = true;
  const open = new Set();
  const live = {};          // betId -> {home_score, away_score, detail, state}
  const matches = {};       // ESPN-Event-ID -> Live-Stand
  let hubUpdated = null;
  let sportFilter = "Alle";
  let showAllEvents = false;
  const fresh = new Set();  // in dieser Sitzung neu abgerechnete Wetten -> Stempel-Animation

  // ------------------------------------------------------------------ Laden
  async function load() {
    try {
      const r = await fetch(`data/state.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      state = await r.json();
      detectNewResults();
      render();
      firstRender = false;
      pollLive();
    } catch (e) {
      console.error(e);
      $("topStatus").textContent = "Daten konnten nicht geladen werden. Die Seite versucht es in einer Minute erneut.";
    }
  }

  // ------------------------------------------------------------------ Neue Ergebnisse feiern
  function detectNewResults() {
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem("pv_seen") || "null"); } catch (_) { /* privat */ }
    const now = {};
    const news = [];
    for (const b of state.bets) {
      now[b.id] = b.status;
      if (seen && b.status !== "open" && seen[b.id] !== b.status) news.push(b);
    }
    try { localStorage.setItem("pv_seen", JSON.stringify(now)); } catch (_) { /* egal */ }
    news.forEach((b) => fresh.add(b.id));
    const mine = news.filter((b) => b.player === (state.players[view] ? view : "analyst"));
    if (!mine.length) return;
    const who = pName(state.players[view] ? view : "analyst");
    const won = mine.filter((b) => b.status === "won");
    const lost = mine.filter((b) => b.status === "lost");
    const sum = mine.reduce((a, b) => a + (b.profit || 0), 0);
    const parts = [];
    if (won.length) parts.push(`${won.length} gewonnen`);
    if (lost.length) parts.push(`${lost.length} verloren`);
    toast(`${who}: ${parts.join(", ") || `${mine.length} Wetten`} neu abgerechnet, zusammen <b>${eur(sum, true)}</b>`, sum < 0);
    if (won.length) setTimeout(() => coins(won.length), 500);
  }

  function toast(html, neg) {
    const t = el("div", "toast" + (neg ? " t-l" : ""), html);
    t.setAttribute("role", "status");
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function coins(n, origin) {
    if (REDUCED) return;
    const fx = $("fx");
    const ox = origin?.x ?? window.innerWidth / 2;
    const oy = origin?.y ?? Math.min(window.innerHeight * 0.45, 320);
    const count = Math.min(10 + n * 6, 36);
    for (let i = 0; i < count; i++) {
      const c = el("span", "coin", "€");
      c.style.left = `${ox - 11}px`; c.style.top = `${oy - 11}px`;
      c.style.setProperty("--dx", `${(Math.random() - 0.5) * 520}px`);
      c.style.setProperty("--up", `${-120 - Math.random() * 220}px`);
      c.style.animationDelay = `${Math.random() * 0.25}s`;
      fx.appendChild(c);
      setTimeout(() => c.remove(), 1800);
    }
  }

  // ------------------------------------------------------------------ Live
  // Spiele, auf die gerade Wetten laufen (Kombi-Spiele einzeln). pid = null: alle Spieler
  function matchEntries(pid = null) {
    const map = new Map();
    const add = (src, pick) => {
      const key = src.espn ? `e${src.espn.id}` : `o${src.event_id}`;
      if (!map.has(key)) map.set(key, { key, espn: src.espn || null, league: src.league, group: src.group, home: src.home, away: src.away, commence: src.commence, picks: [] });
      map.get(key).picks.push(pick);
    };
    for (const b of state?.bets || []) {
      if (b.status !== "open" || (pid && b.player !== pid)) continue;
      if (b.market === "combo") {
        for (const l of b.legs) if (l.status === "open") add(l, { player: b.player, label: l.label, odds: l.odds, stake: b.stake, market: l.market, key: l.key, point: l.point, combo: b.label });
      } else add(b, { player: b.player, label: b.label, odds: b.odds, stake: b.stake, market: b.market, key: b.key, point: b.point });
    }
    const rank = (id) => state.order.indexOf(id);
    const out = [...map.values()];
    out.forEach((e) => e.picks.sort((x, y) => rank(x.player) - rank(y.player)));
    return out.sort((x, y) => x.commence.localeCompare(y.commence));
  }
  const inPlayWindow = (e) => {
    const now = Date.now(), t = new Date(e.commence).getTime();
    return now >= t - 5 * 60e3 && now <= t + ((DUR[e.group] || 2.5) + 1.5) * 3600e3;
  };

  let lastFullPoll = 0;
  async function pollLive() {
    if (!state) return;
    const full = Date.now() - lastFullPoll > 5 * 60e3;
    const soon = (e) => new Date(e.commence).getTime() - Date.now() < 36 * 3600e3;
    const pool = [...matchEntries(), ...recentEntries()].filter((e) => e.espn && (inPlayWindow(e) || (full && soon(e))));
    const goals = new Set();
    if (pool.length) {
      if (full) lastFullPoll = Date.now();
      const want = new Map();
      for (const e of pool) {
        const t = new Date(e.commence);
        for (const h of [-8, 0]) {
          const d = new Date(t.getTime() + h * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
          want.set(`${e.espn.path}|${d}`, [e.espn.path, d]);
        }
      }
      const events = {};
      await Promise.all([...want.values()].map(async ([path, d]) => {
        try {
          const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${d}`);
          const j = await r.json();
          for (const ev of j.events || []) events[ev.id] = ev;
        } catch (_) { /* nächster Versuch */ }
      }));
      for (const e of pool) {
        const ev = events[e.espn.id];
        if (!ev) continue;
        const c = ev.competitions[0];
        const side = (ha) => c.competitors.find((x) => x.homeAway === ha);
        const h = side("home"), a = side("away");
        const nv = {
          home_score: +h.score || 0, away_score: +a.score || 0,
          detail: ev.status.type.shortDetail, state: ev.status.type.state, name: ev.status.type.name,
          clock: ev.status.displayClock, period: ev.status.period,
          home_abbr: h.team.abbreviation, away_abbr: a.team.abbreviation,
          home_color: h.team.color, away_color: a.team.color, home_id: h.team.id, away_id: a.team.id,
          details: c.details || [],
        };
        const old = matches[e.espn.id];
        if (old && old.state === "in" && (old.home_score !== nv.home_score || old.away_score !== nv.away_score)) { goals.add(e.key); localFeed(e, old, nv); }
        if (old && old.state === "pre" && nv.state === "in") pushFeed({ id: `ko-${e.key}`, t: Date.now(), kind: "info", tag: "Anpfiff", text: `${e.home} – ${e.away}`, league: e.league });
        if (old && old.state === "in" && nv.state === "post") pushFeed({ id: `ft-${e.key}`, t: Date.now(), kind: "info", tag: "Abpfiff", text: `${e.home} ${nv.home_score}:${nv.away_score} ${e.away}`, league: e.league });
        matches[e.espn.id] = nv;
      }
      for (const b of state.bets) if (b.espn && matches[b.espn.id]) live[b.id] = matches[b.espn.id];
      hubUpdated = new Date();
    }
    renderHub(goals);
    renderScorebar();
    renderFeed();
    if (pool.length) {
      if (view !== "vergleich") { renderSlips(); renderDays(); }
      renderTop();
    }
  }

  // ------------------------------------------------------------------ Wett-Hilfen
  function grade(b, hs, as) {
    const k = b.key, pt = b.point;
    if (b.market === "h2h") { const r = hs > as ? "home" : as > hs ? "away" : "draw"; return r === k ? "won" : "lost"; }
    if (b.market === "totals") { const t = hs + as; if (t === pt) return "push"; return (t > pt) === (k === "over") ? "won" : "lost"; }
    if (b.market === "spreads") { const m = hs - as + pt; if (m === 0) return "push"; return (m > 0) === (k === "home") ? "won" : "lost"; }
    return null;
  }
  const isLive = (b) => live[b.id] && live[b.id].state === "in" && b.status === "open";

  function stamp(b) {
    const lv = live[b.id];
    const slam = fresh.has(b.id) ? " slam" : "";
    if (b.status === "won") return `<span class="stamp st-won${slam}">Gewonnen<small>${eur(b.profit, true)}</small></span>`;
    if (b.status === "lost") return `<span class="stamp st-lost${slam}">Verloren<small>${eur(b.profit, true)}</small></span>`;
    if (b.status === "push" || b.status === "void") return `<span class="stamp st-push">${b.status === "push" ? "Push" : "Abgesagt"}<small>Einsatz zurück</small></span>`;
    if (lv && lv.state === "in") return `<span class="stamp st-live">Live ${lv.home_score}:${lv.away_score}<small>${esc(lv.detail)}</small></span>`;
    if (lv && lv.state === "post") return `<span class="stamp st-open">Wird abgerechnet<small>${lv.home_score}:${lv.away_score}</small></span>`;
    return `<span class="stamp st-open">Offen<small data-countdown="${b.commence}">${countdownText(b.commence)}</small></span>`;
  }

  function countdownText(iso) {
    const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    if (s <= 0) return "läuft";
    if (s > 6 * 3600) return `${wd(iso)} ${hhmm(iso)}`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `in ${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `in ${m}:${String(sec).padStart(2, "0")}`;
  }

  // ------------------------------------------------------------------ Render
  function render() {
    const cmp = view === "vergleich";
    $("boardCompare").hidden = !cmp; $("compareView").hidden = !cmp;
    $("boardPlayer").hidden = cmp; $("playerView").hidden = cmp;
    renderTabs();
    renderTop();
    renderHub();
    renderScorebar();
    renderFeed();
    if (cmp) { renderCompare(); renderMethod(); renderSys(); return; }
    renderBoard();
    renderChart();
    renderDayChart();
    renderDays();
    renderSlips();
    renderLeagues();
    renderClv();
    renderHits();
    renderSkill();
    renderMethod();
    renderSys();
  }

  function renderTop() {
    if (!state) return;
    const today = berlinDate();
    const i = state.days.findIndex((d) => d.date === today);
    const lv = matchEntries().filter((e) => e.espn && matches[e.espn.id]?.state === "in").length;
    let txt, short;
    if (i >= 0) { txt = `<b>Tag ${i + 1}</b> von ${state.experiment.days}`; short = `<b>Tag ${i + 1}</b>/${state.experiment.days}`; }
    else if (today < state.days[0].date) { txt = `Start am ${fmt(state.days[0].date + "T12:00:00", { weekday: "long", day: "numeric", month: "long" })}`; short = `Start ${fmt(state.days[0].date + "T12:00:00", { weekday: "short", day: "numeric", month: "numeric" })}`; }
    else { txt = "Experiment beendet"; short = "Beendet"; }
    const lvTxt = lv ? `, <b>${lv} ${lv === 1 ? "Spiel" : "Spiele"} live</b>` : "";
    $("topStatus").innerHTML = `<span class="dot ${lv ? "is-live" : ""}"></span><span class="st-long">${txt}${lvTxt}, aktualisiert ${hhmm(state.generated_at)} Uhr</span><span class="st-short">${short}${lvTxt}, ${hhmm(state.generated_at)}</span>`;
  }

  // Zahlenwalzen für den Kontostand
  function odometer(node, text) {
    const chars = [...text];
    const shape = chars.map((c) => (/\d/.test(c) ? "d" : c)).join("");
    if (node.dataset.shape !== shape) {
      node.innerHTML = "";
      chars.forEach((c) => {
        if (/\d/.test(c)) {
          const reel = el("span", "reel");
          const strip = el("span", "reel-strip");
          for (let k = 0; k < 20; k++) strip.appendChild(el("span", null, String(k % 10)));
          reel.appendChild(strip);
          node.appendChild(reel);
        } else node.appendChild(el("span", "reel-static", esc(c)));
      });
      node.appendChild(el("span", "cur", "€"));
      node.dataset.shape = shape;
    }
    const strips = node.querySelectorAll(".reel-strip");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      let di = 0;
      chars.forEach((c) => {
        if (!/\d/.test(c)) return;
        const s = strips[di++];
        s.style.transitionDelay = `${di * 70}ms`;
        s.style.transform = `translateY(-${(10 + +c) * 5}%)`;
      });
    }));
  }

  function renderBoard() {
    const t = P().totals;
    const settled = t.won + t.lost + t.push;
    const bal = $("balance");
    bal.className = "balance" + (t.profit > 0.004 ? " pos" : t.profit < -0.004 ? " neg" : "");
    bal.setAttribute("aria-label", `Gewinn ${eur(t.profit, true)}`);
    odometer(bal, sgn(t.profit) + nf2.format(Math.abs(t.profit)));
    $("heroKicker").textContent = settled ? `${P().name}: Gewinn nach ${settled} abgerechneten ${settled === 1 ? "Wette" : "Wetten"}` : `${P().name}: noch keine Wette abgerechnet`;
    const total = state.experiment.total_budget;
    let line = `<b>${eur0(total)} Spielgeld</b>, ${state.experiment.days} Tage, jeden Tag genau ${eur0(state.experiment.daily_budget)} gesetzt.`;
    if (t.staked) line += ` Bisher ${eur(t.staked)} im Spiel, <b>${eur(t.returned)}</b> kamen zurück.`;
    else line += " Die ersten Wetten gehen am Starttag um 11:00 Uhr raus.";
    $("heroLine").innerHTML = line;
    $("bSettled").style.width = `${(t.staked_settled / total) * 100}%`;
    $("bOpen").style.width = `${(t.open_stake / total) * 100}%`;
    $("budgetLegend").innerHTML = `<span style="--c:var(--pen)">abgerechnet ${eur0(t.staked_settled)}</span><span style="--c:var(--live)">offen ${eur0(t.open_stake)}</span><span style="--c:var(--board-2)">übrig ${eur0(Math.max(0, total - t.staked))}</span>`;

    const next = myBets().filter((b) => b.status === "open" && new Date(b.commence) > new Date()).sort((a, b) => a.commence.localeCompare(b.commence))[0];
    const roiCls = t.roi > 0 ? "k-gain" : t.roi < 0 ? "k-loss" : "";
    const clvCls = t.avg_clv > 0 ? "k-gain" : t.avg_clv < 0 ? "k-loss" : "";
    const kpis = [
      ["Rendite", t.roi == null ? "–" : pct(t.roi, true), `auf ${eur0(t.staked_settled)} Einsatz`, roiCls],
      ["Trefferquote", t.hit_rate == null ? "–" : pct(t.hit_rate), t.won + t.lost ? `${t.won} von ${t.won + t.lost} Wetten` : "noch keine", ""],
      ["Ø Quote", t.avg_odds ? odds(t.avg_odds) : "–", "über alle Wetten", ""],
      ["Ø Closing Line Value", t.avg_clv == null ? "–" : pct(t.avg_clv, true), t.n_clv ? `${t.clv_positive} von ${t.n_clv} besser als Schluss` : "noch keine Schlusskurse", clvCls],
      ["Mögliche Auszahlung", t.open_stake ? eur(t.open_potential) : "–", t.open_stake ? `bei ${eur0(t.open_stake)} Einsatz` : "nichts offen", ""],
      ["Nächster Anpfiff", next ? `<span data-countdown="${next.commence}">${countdownText(next.commence)}</span>` : "–", next ? `${esc(next.home)} – ${esc(next.away)}` : "keine offenen Spiele", "k-count"],
    ];
    $("facts").innerHTML = kpis.map(([k, v, s, c]) => `<div><dt>${k}</dt><dd class="${c}">${v}<small>${s}</small></dd></div>`).join("");
  }

  // ------------------------------------------------------------------ Score-Leiste
  function recentEntries() {
    const map = new Map();
    const cut = Date.now() - 20 * 3600e3;
    for (const b of state?.bets || []) {
      if (b.status === "open" || b.market === "combo" || !b.result || b.result.home == null || new Date(b.commence).getTime() < cut) continue;
      const key = b.espn ? `e${b.espn.id}` : `o${b.event_id}`;
      if (!map.has(key)) map.set(key, { key, espn: b.espn || null, league: b.league, group: b.group, home: b.home, away: b.away, commence: b.commence, final: { home: b.result.home, away: b.result.away }, profit: 0, picks: [] });
      const e = map.get(key);
      if (b.player === "analyst") e.profit += b.profit || 0;
      e.picks.push(b);
    }
    return [...map.values()].sort((x, y) => y.commence.localeCompare(x.commence));
  }
  const abbr = (name) => name.replace(/^(FC|SC|SV|VfB|VfL|TSG|FSV|1\.|AS|AC|RB)\s+/g, "").slice(0, 3).toUpperCase();
  const hue = (t) => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 38%)`; };
  function teamBadge(name, m, side) {
    const ab = m?.[`${side}_abbr`] || abbr(name);
    const col = m?.[`${side}_color`] ? `#${m[`${side}_color`]}` : hue(name);
    return `<i class="tm" style="--t:${col}">${esc(ab)}</i>`;
  }
  function sbTile(e, kind) {
    const m = e.espn ? matches[e.espn.id] : null;
    const hs = kind === "final" ? (e.final?.home ?? m?.home_score) : m?.home_score;
    const as = kind === "final" ? (e.final?.away ?? m?.away_score) : m?.away_score;
    const head = kind === "live" ? `<b class="sb-live">${esc(clockDe(m))}</b>` : kind === "final" ? "Endstand" : `${wd(e.commence)} ${hhmm(e.commence)}`;
    let bet = "";
    if (kind === "live") {
      let sum = 0, n = 0;
      for (const p of e.picks) if (!p.combo) { sum += betStory(p, e, hs, as).profit; n++; }
      if (n) bet = `<span class="sb-bet ${sum > 0 ? "up" : sum < 0 ? "down" : ""}">${sum > 0 ? "▲" : sum < 0 ? "▼" : "■"} ${eur(sum, true)}</span>`;
    } else if (kind === "next") bet = `<span class="sb-bet">${plural(e.picks.length, "Wette", "Wetten")}</span>`;
    const score = (v) => (v == null || kind === "next" ? "" : `<b>${v}</b>`);
    return `<a class="sb-tile ${kind === "live" ? "is-live" : ""}" href="#m-${esc(e.key)}">
      <span class="sb-head"><span>${esc(e.league)}</span><span>${head}</span></span>
      <span class="sb-row">${teamBadge(e.home, m, "home")}<span class="sb-name">${esc(e.home)}</span>${score(hs)}</span>
      <span class="sb-row">${teamBadge(e.away, m, "away")}<span class="sb-name">${esc(e.away)}</span>${score(as)}</span>${bet}</a>`;
  }
  let sbOffset = 0, sbBase = 0, sbPaused = false, sbLast = 0, sbHtml = "";
  function renderScorebar() {
    if (!state) return;
    const all = matchEntries();
    const st = (e) => (e.espn && matches[e.espn.id] ? matches[e.espn.id].state : null);
    const running = all.filter((e) => st(e) === "in");
    const next = all.filter((e) => st(e) !== "in" && st(e) !== "post" && new Date(e.commence) > new Date()).slice(0, 10);
    const done = recentEntries().slice(0, 8);
    const tiles = [...running.map((e) => sbTile(e, "live")), ...next.map((e) => sbTile(e, "next")), ...done.map((e) => sbTile(e, "final"))];
    $("sbLabel").textContent = running.length ? "Live" : "Scores";
    $("sbLabel").classList.toggle("is-live", !!running.length);
    const track = $("sbTrack");
    if (!tiles.length) { track.innerHTML = `<span class="sb-empty">Die nächsten Wetten werden um 11:00 Uhr gesetzt.</span>`; sbBase = 0; sbHtml = ""; return; }
    const repeat = Math.max(2, Math.ceil(window.innerWidth / (tiles.length * 190)) + 1);
    const html = tiles.join("");
    if (html === sbHtml && track.children.length) return;
    sbHtml = html;
    track.innerHTML = Array(repeat).fill(html).join("");
    sbBase = track.scrollWidth / repeat;
    if (sbOffset >= sbBase) sbOffset = 0;
  }
  function sbFrame(ts) {
    if (sbLast && !sbPaused && sbBase) {
      sbOffset += (ts - sbLast) * 0.04;
      if (sbOffset >= sbBase) sbOffset -= sbBase;
      $("sbTrack").style.transform = `translateX(${-sbOffset}px)`;
    }
    sbLast = ts;
    requestAnimationFrame(sbFrame);
  }

  // ------------------------------------------------------------------ Live-Ticker (Tore, Karten, An-/Abpfiff)
  const feedItems = new Map();
  const feedSeen = new Set();
  const pushFeed = (item) => { if (!feedItems.has(item.id)) feedItems.set(item.id, item); };
  function localFeed(e, old, nv) {
    if (e.group === "Fußball") return; // kommt aus den ESPN-Details
    const lead = (m) => Math.sign(m.home_score - m.away_score);
    if (e.group === "Basketball" && lead(old) === lead(nv)) return;
    const tag = e.group === "Basketball" ? "Führungswechsel" : e.group === "Eishockey" ? "Tor" : "Punkte";
    pushFeed({ id: `s-${e.key}-${nv.home_score}-${nv.away_score}`, t: Date.now(), kind: tag === "Führungswechsel" ? "info" : "goal", tag, text: `${e.home} ${nv.home_score}:${nv.away_score} ${e.away}`, league: e.league, ekey: e.key, clock: clockDe(nv) });
  }
  function collectDetails() {
    for (const e of matchEntries()) {
      const m = e.espn ? matches[e.espn.id] : null;
      if (!m || m.state === "pre") continue;
      const lastGoal = [...m.details].reverse().find((d) => d.scoringPlay);
      for (const d of m.details) {
        const kind = d.scoringPlay ? "goal" : d.redCard ? "red" : d.yellowCard ? "yellow" : null;
        if (!kind) continue;
        const min = parseInt(d.clock?.displayValue, 10) || 0;
        const who = (d.athletesInvolved || []).map((a) => a.displayName).join(", ");
        const team = d.team?.id === m.home_id ? e.home : e.away;
        const tag = d.ownGoal ? "Eigentor" : d.penaltyKick && d.scoringPlay ? "Elfmeter" : kind === "goal" ? "Tor" : kind === "red" ? "Rot" : "Gelb";
        const t = new Date(e.commence).getTime() + (min + (min > 45 ? 15 : 0)) * 60e3;
        const id = `${e.key}-${kind}-${d.clock?.displayValue}-${who}`;
        feedItems.set(id, { id, t, kind, tag, clock: d.clock?.displayValue, text: who ? `${who} (${team})` : team, league: `${e.home} – ${e.away}`, ekey: d === lastGoal ? e.key : null });
      }
    }
  }
  function goalImpact(ekey) {
    const pid = state.players[view] ? view : null;
    const e = matchEntries(pid).find((x) => x.key === ekey);
    const m = e && e.espn ? matches[e.espn.id] : null;
    if (!m) return "";
    const parts = e.picks.filter((p) => !p.combo).slice(0, 3).map((p) => {
      const s = betStory(p, e, m.home_score, m.away_score);
      return `<span class="${s.g === "won" ? "up" : s.g === "lost" ? "down" : ""}">${esc(shortName(p.player))} ${s.g === "won" ? "▲" : s.g === "lost" ? "▼" : "■"} ${eur(s.profit, true)}</span>`;
    });
    return `<span class="fd-impact"><b>${m.home_score}:${m.away_score}</b> ${parts.join(" ")}</span>`;
  }
  function renderFeed() {
    if (!state) return;
    collectDetails();
    const items = [...feedItems.values()].sort((a, b) => b.t - a.t).slice(0, 30);
    const firstPaint = !feedSeen.size;
    $("feed").innerHTML = items.length ? items.map((it) => {
      const isNew = !firstPaint && !feedSeen.has(it.id);
      return `<li class="fd fd-${it.kind} ${isNew ? "fd-new" : ""}"><span class="fd-min">${esc(it.clock || hhmm(new Date(it.t).toISOString()))}</span><div class="fd-body"><span class="fd-tag">${esc(it.tag)}</span> ${esc(it.text)}<small>${esc(it.league)}</small>${it.ekey ? goalImpact(it.ekey) : ""}</div></li>`;
    }).join("") : `<li class="fd-empty">Sobald unsere Spiele laufen, erscheinen hier Tore, Karten und Abpfiffe.</li>`;
    items.forEach((it) => feedSeen.add(it.id));
  }

  // ------------------------------------------------------------------ Wettschein-Spalte
  function renderSlipRail() {
    const pid = state.players[view] ? view : null;
    const open = state.bets.filter((b) => b.status === "open" && (!pid || b.player === pid));
    const stake = open.reduce((a, b) => a + b.stake, 0), pot = open.reduce((a, b) => a + b.potential_payout, 0);
    let body;
    if (!open.length) body = `<p class="fd-empty">Gerade sind keine Wetten offen.</p>`;
    else if (!pid) {
      body = `<ul class="rs-list">${state.order.map((id) => {
        const bs = open.filter((b) => b.player === id);
        if (!bs.length) return "";
        return `<li><button type="button" class="rs-player" data-v="${id}"><i style="background:${state.players[id].color}"></i><span>${esc(pName(id))}<small>${plural(bs.length, "Wette", "Wetten")} offen</small></span><b>${eur(bs.reduce((a, b) => a + b.potential_payout, 0))}</b></button></li>`;
      }).join("")}</ul>`;
    } else {
      const sorted = [...open].sort((a, b) => a.commence.localeCompare(b.commence));
      body = `<ul class="rs-list">${sorted.slice(0, 10).map((b) => `<li class="rs-bet"><div><b>${esc(b.label)}</b><small>${b.market === "combo" ? esc(b.league) : `${esc(b.home)} – ${esc(b.away)}`}</small></div><span class="rs-odds">${odds(b.odds)}</span><span class="rs-stake">${eur0(b.stake)}</span></li>`).join("")}</ul>${sorted.length > 10 ? `<p class="fd-empty">und ${sorted.length - 10} weitere</p>` : ""}`;
    }
    $("slipRail").innerHTML = `${body}<dl class="rs-total"><div><dt>Einsatz offen</dt><dd>${eur(stake)}</dd></div><div><dt>Mögliche Auszahlung</dt><dd class="rs-pot">${eur(pot)}</dd></div></dl>`;
    $("slipRail").querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => { setView(b.dataset.v); window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }); }));
    const bar = $("slipbar");
    bar.hidden = !open.length;
    bar.innerHTML = `<span>Wettschein: <b>${plural(open.length, "Wette", "Wetten")}</b> offen</span><span>Möglich <b>${eur(pot)}</b></span>`;
  }

  // ------------------------------------------------------------------ Chart-Hilfen
  const NS = "http://www.w3.org/2000/svg";
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function scale(vals, ticks = 4) {
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const step = niceStep((hi - lo || 10) / ticks);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    if (lo === hi) hi = lo + step;
    return { lo, hi, step };
  }
  const yTick = (v, unit = " €") => `${sgn(v)}${Math.abs(Math.round(v))}${unit}`;
  function svgIn(box, W, H, inner) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = inner;
    box.appendChild(svg);
    const tip = el("div", "tip"); tip.hidden = true; box.appendChild(tip);
    return { svg, tip };
  }
  function bindMarkTips(svg, tip, W, H, getHtml) {
    svg.querySelectorAll(".hit[data-i]").forEach((m) => {
      m.addEventListener("pointerenter", () => {
        svg.querySelectorAll(".is-hover").forEach((x) => x.classList.remove("is-hover"));
        const target = svg.querySelector(`.mark[data-i="${m.dataset.i}"]`);
        if (target) target.classList.add("is-hover");
        tip.hidden = false;
        tip.style.left = `${(+m.dataset.x / W) * 100}%`;
        tip.style.top = `${(+m.dataset.y / H) * 100}%`;
        tip.innerHTML = getHtml(+m.dataset.i);
      });
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; svg.querySelectorAll(".is-hover").forEach((x) => x.classList.remove("is-hover")); });
  }
  const anim = (cls) => (firstRender && !REDUCED ? cls : "");
  function gridAxis(lo, hi, step, y, m, W, unit) {
    let s = `<g class="grid">`;
    for (let v = lo; v <= hi + 1e-9; v += step) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `</g><g class="axis">`;
    for (let v = lo; v <= hi + 1e-9; v += step) s += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${yTick(v, unit)}</text>`;
    return s + `</g>`;
  }

  // ------------------------------------------------------------------ Kontoverlauf
  function series() {
    const done = myBets().filter((b) => b.status !== "open")
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
    const W = box.clientWidth || 700, H = box.clientHeight || 280;
    const m = { l: 52, r: 78, t: 12, b: 26 };
    const { lo, hi, step } = scale(pts.flatMap((p) => [p.real, p.exp]));
    const n = pts.length - 1;
    const x = (i) => m.l + (i / n) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    let g = gridAxis(lo, hi, step, y, m, W, " €") + `<g class="axis">`;
    let lastDay = null;
    pts.forEach((p) => {
      if (!p.bet || p.bet.day === lastDay) return;
      lastDay = p.bet.day;
      g += `<text x="${x(p.i)}" y="${H - 6}" text-anchor="middle">${wd(p.bet.day + "T12:00:00")}</text>`;
    });
    g += `</g>`;
    const path = (k) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
    const last = pts[n];
    const ly = [y(last.real), y(last.exp)];
    if (Math.abs(ly[0] - ly[1]) < 16) { const mid = (ly[0] + ly[1]) / 2, up = ly[0] <= ly[1]; ly[0] = mid + (up ? -8 : 8); ly[1] = mid + (up ? 8 : -8); }
    const { svg, tip } = svgIn(box, W, H, `${g}
      <line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>
      <path class="area" d="${path("real")}L${x(n)},${y(0)}L${x(0)},${y(0)}Z"/>
      <path class="exp ${anim("draw")}" d="${path("exp")}"/>
      <path class="real ${anim("draw")}" d="${path("real")}"/>
      <circle cx="${x(n)}" cy="${y(last.exp)}" r="4" fill="var(--ochre)" class="hoverdot"/>
      <circle cx="${x(n)}" cy="${y(last.real)}" r="4.5" fill="var(--pen)" class="hoverdot"/>
      <text class="lbl-strong" x="${x(n) + 10}" y="${ly[0] + 4}">${eur(last.real, true)}</text>
      <text class="lbl" x="${x(n) + 10}" y="${ly[1] + 4}">${eur(last.exp, true)}</text>
      <g class="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${H - m.b}"/>
        <circle r="4" fill="var(--ochre)" class="hoverdot hd-exp"/><circle r="4.5" fill="var(--pen)" class="hoverdot hd-real"/></g>`);
    svg.querySelectorAll(".draw").forEach((p) => p.style.setProperty("--len", p.getTotalLength()));
    const hover = svg.querySelector(".hover");
    svg.addEventListener("pointermove", (ev) => {
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
      tip.innerHTML = p.bet ? `Nach Wette ${i}: ${esc(p.bet.home)} – ${esc(p.bet.away)}<br><b>Echt ${eur(p.real, true)}</b>, erwartet ${eur(p.exp, true)}` : "Start: 0 €";
    });
    svg.addEventListener("pointerleave", () => { hover.style.display = "none"; tip.hidden = true; });
    $("chartTable").innerHTML = `<table><thead><tr><th>Nr.</th><th>Spiel</th><th>Ergebnis</th><th class="num">Echt</th><th class="num">Erwartet</th></tr></thead><tbody>${pts.slice(1).map((p) =>
      `<tr><td>${p.i}</td><td>${esc(p.bet.home)} – ${esc(p.bet.away)}</td><td>${p.bet.status === "won" ? "Gewonnen" : p.bet.status === "lost" ? "Verloren" : "Zurück"}</td><td class="num">${eur(p.real, true)}</td><td class="num">${eur(p.exp, true)}</td></tr>`).join("")}</tbody></table>`;
  }

  // Balken mit 4px runder Datenkante, gerade an der Nulllinie
  function barPath(cx, bw, y0, y1) {
    const up = y1 < y0, h = Math.max(2, Math.abs(y1 - y0)), r = Math.min(4, h / 2, bw / 2);
    const l = cx - bw / 2, rt = cx + bw / 2;
    if (up) { const t = y0 - h; return `M${l},${y0}V${t + r}Q${l},${t} ${l + r},${t}H${rt - r}Q${rt},${t} ${rt},${t + r}V${y0}Z`; }
    const b = y0 + h; return `M${l},${y0}V${b - r}Q${l},${b} ${l + r},${b}H${rt - r}Q${rt},${b} ${rt},${b - r}V${y0}Z`;
  }

  // ------------------------------------------------------------------ Bilanz pro Tag
  function renderDayChart() {
    const box = $("dayChart");
    box.innerHTML = "";
    const days = P().days;
    if (!days.some((d) => d.settled)) {
      box.innerHTML = `<div class="chart-empty">Hier erscheint für jeden der 7 Tage ein Balken: grün im Plus, orange im Minus.</div>`;
      return;
    }
    const W = box.clientWidth || 340, H = box.clientHeight || 280;
    const m = { l: 44, r: 6, t: 22, b: 26 };
    // 18 % Luft über/unter den Balken für die Wertbeschriftung
    const { lo, hi, step } = scale(days.flatMap((d) => [d.profit * 1.18]));
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const band = (W - m.l - m.r) / days.length;
    const bw = Math.min(24, band * 0.6);
    let s = gridAxis(lo, hi, step, y, m, W, " €");
    days.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      s += `<text class="lbl" x="${cx}" y="${H - 6}" text-anchor="middle">${wd(d.date + "T12:00:00")}</text>`;
      if (!d.settled) {
        if (d.n_bets) s += `<rect class="bar-open" x="${cx - bw / 2}" y="${y(0) - 3}" width="${bw}" height="6" rx="2"/>`;
        return;
      }
      const v = d.profit;
      s += `<path class="mark ${v >= 0 ? "bar-gain" : "bar-loss"} ${anim("grow")}" style="--origin:${v >= 0 ? "bottom" : "top"};--d:${i * 70}ms" data-i="${i}" d="${barPath(cx, bw, y(0), y(v))}"/>`;
      s += `<text class="lbl-strong" x="${cx}" y="${v >= 0 ? Math.min(y(v), y(0) - 2) - 6 : Math.max(y(v), y(0) + 2) + 14}" text-anchor="middle">${sgn(v)}${Math.abs(Math.round(v))}</text>`;
      s += `<rect class="hit" data-i="${i}" data-x="${cx}" data-y="${Math.min(y(v), y(0))}" x="${cx - band / 2}" y="${m.t}" width="${band}" height="${H - m.t - m.b}"/>`;
    });
    s += `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    const { svg, tip } = svgIn(box, W, H, s);
    bindMarkTips(svg, tip, W, H, (i) => {
      const d = days[i];
      return `Tag ${i + 1}, ${fmt(d.date + "T12:00:00", { weekday: "long" })}<br><b>${eur(d.profit, true)}</b> bei ${eur0(d.staked)} Einsatz, ${d.n_bets} Wetten`;
    });
  }

  // ------------------------------------------------------------------ Wettbewerbe
  function renderLeagues() {
    const box = $("leagueChart");
    const settled = myBets().filter((b) => b.status !== "open");
    if (!settled.length) { box.innerHTML = `<div class="empty-small">Erscheint nach den ersten Ergebnissen.</div>`; return; }
    const by = {};
    for (const b of settled) {
      const o = by[b.league] ||= { league: b.league, stake: 0, profit: 0, n: 0, won: 0 };
      o.stake += b.stake; o.profit += b.profit || 0; o.n++; if (b.status === "won") o.won++;
    }
    const rows = Object.values(by).sort((a, b) => b.stake - a.stake);
    const max = Math.max(...rows.map((r) => Math.abs(r.profit)), 1);
    box.innerHTML = rows.map((r, i) => {
      const w = (Math.abs(r.profit) / max) * 50;
      const cls = r.profit >= 0 ? "gain" : "loss";
      const left = r.profit >= 0 ? 50 : 50 - w;
      return `<div class="hb-name">${esc(r.league)}<small>${r.n} Wetten, ${r.won} gewonnen</small></div>
        <div class="hb-track"><span class="hb-mid" style="left:50%"></span><span class="hb-bar ${cls} ${anim("growx")} ${r.profit < 0 ? "from-right" : ""}" style="left:${left}%;width:${Math.max(w, 0.6)}%;--d:${i * 60}ms"></span></div>
        <div class="hb-val">${eur(r.profit, true)}<small>${eur0(Math.round(r.stake * 100) / 100)} gesetzt</small></div>`;
    }).join("");
  }

  // ------------------------------------------------------------------ CLV je Wette
  function renderClv() {
    const box = $("clvChart");
    box.innerHTML = "";
    const bets = myBets().filter((b) => b.clv != null).sort((a, b) => a.commence.localeCompare(b.commence));
    if (!bets.length) { box.innerHTML = `<div class="chart-empty">Kurz vor jedem Anpfiff wird der faire Schlusskurs erfasst. Dann erscheint hier je Wette ein Balken.</div>`; return; }
    const W = box.clientWidth || 500, H = box.clientHeight || 230;
    const m = { l: 44, r: 6, t: 10, b: 10 };
    const vals = bets.map((b) => b.clv * 100);
    const { lo, hi, step } = scale(vals);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const band = (W - m.l - m.r) / bets.length;
    const bw = Math.max(2, Math.min(18, band - 2));
    let s = gridAxis(lo, hi, step, y, m, W, " %");
    bets.forEach((b, i) => {
      const v = vals[i], cx = m.l + band * i + band / 2;
      s += `<path class="mark ${v >= 0 ? "bar-gain" : "bar-loss"} ${anim("grow")}" style="--origin:${v >= 0 ? "bottom" : "top"};--d:${i * 25}ms" data-i="${i}" d="${barPath(cx, bw, y(0), y(v))}"/>`;
      s += `<rect class="hit" data-i="${i}" data-x="${cx}" data-y="${Math.min(y(v), y(0))}" x="${cx - band / 2}" y="${m.t}" width="${band}" height="${H - m.t - m.b}"/>`;
    });
    s += `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    const { svg, tip } = svgIn(box, W, H, s);
    bindMarkTips(svg, tip, W, H, (i) => {
      const b = bets[i];
      return `${esc(b.home)} – ${esc(b.away)}<br>${esc(b.label)} zu ${odds(b.odds)}, fair zum Schluss ${odds(b.closing?.fair_odds)}<br><b>CLV ${pct(b.clv, true)}</b>`;
    });
  }

  // ------------------------------------------------------------------ Treffer nach Quotenbereich
  function renderHits() {
    const box = $("hitChart");
    const settled = myBets().filter((b) => b.status === "won" || b.status === "lost");
    if (!settled.length) { box.innerHTML = `<div class="empty-small">Erscheint nach den ersten Ergebnissen.</div>`; return; }
    const buckets = [["bis 1,60", 0, 1.6], ["1,60–2,20", 1.6, 2.2], ["2,20–3,00", 2.2, 3.0], ["über 3,00", 3.0, 99]];
    const rows = buckets.map(([name, a, z]) => {
      const bs = settled.filter((b) => b.odds >= a && b.odds < z);
      return { name, n: bs.length, exp: bs.reduce((s, b) => s + (b.p || 1 / b.odds), 0), real: bs.filter((b) => b.status === "won").length };
    }).filter((r) => r.n);
    const max = Math.max(...rows.map((r) => Math.max(r.exp, r.real)), 1);
    box.innerHTML = `<div class="hb-legend"><span style="--c:var(--ochre)">erwartete Treffer</span><span style="--c:var(--pen)">echte Treffer</span></div>` + rows.map((r, i) => `
      <div class="hb-name">Quote ${r.name}<small>${r.n} Wetten</small></div>
      <div class="hb-track"><span class="hb-bar exp ${anim("growx")}" style="left:0;width:${(r.exp / max) * 100}%;--d:${i * 60}ms"></span><span class="hb-bar real ${anim("growx")}" style="left:0;width:${Math.max((r.real / max) * 100, 0.6)}%;--d:${i * 60 + 80}ms"></span></div>
      <div class="hb-val">${r.real} von ${r.n}<small>erwartet ${nf1.format(r.exp)}</small></div>`).join("");
  }

  // ------------------------------------------------------------------ Woche
  function renderDays() {
    const today = berlinDate();
    if (!selectedDay) {
      const withBets = P().days.filter((d) => d.n_bets);
      selectedDay = state.days.find((d) => d.date === today)?.date || withBets.at(-1)?.date || state.days[0].date;
    }
    const box = $("days");
    box.innerHTML = "";
    P().days.forEach((d, i) => {
      const b = el("button", "day" + (d.date === today ? " d-today" : ""));
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", d.date === selectedDay);
      const dt = d.date + "T12:00:00";
      let val, meta;
      if (!d.n_bets) { val = `<span class="d-profit" style="opacity:.45">–</span>`; meta = d.date < today ? "keine Wetten" : "Wetten ab 11:00"; }
      else {
        const cls = d.profit > 0 ? "d-pos" : d.profit < 0 ? "d-neg" : "";
        val = `<span class="d-profit ${cls}">${d.settled ? eur(d.profit, true) : "offen"}</span>`;
        meta = d.settled === d.n_bets ? `${d.n_bets} Wetten, fertig` : `${d.settled} von ${d.n_bets} fertig`;
      }
      const dbets = myBets().filter((x) => x.day === d.date);
      const spark = dbets.length ? `<span class="d-spark">${dbets.map((x) => `<i class="${x.status === "won" ? "w" : x.status === "lost" ? "l" : isLive(x) ? "o" : ""}"></i>`).join("")}</span>` : "";
      b.innerHTML = `<span class="d-name">Tag ${i + 1}</span><span class="d-date">${wd(dt)}, ${fmt(dt, { day: "numeric", month: "short" })}</span>${val}<span class="d-meta">${meta}</span>${spark}`;
      b.addEventListener("click", () => { selectedDay = d.date; renderDays(); renderSlips(); });
      box.appendChild(b);
    });
  }

  // ------------------------------------------------------------------ Wettscheine
  function renderSlips() {
    if (!state) return;
    const d = state.days.find((x) => x.date === selectedDay);
    if (!d) return;
    const idx = state.days.indexOf(d);
    const bets = myBets().filter((b) => b.day === selectedDay).sort((a, b) => a.commence.localeCompare(b.commence));
    $("dayTitle").textContent = `Wetten an Tag ${idx + 1}`;
    const dt = d.date + "T12:00:00";
    let meta = `${P().name}, ${fmt(dt, { weekday: "long", day: "numeric", month: "long" })}. Spiele von 12 Uhr bis 12 Uhr am Folgetag.`;
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
    // Gewinn-Stempel: Münzen springen aus dem Stempel
    box.querySelectorAll(".st-won.slam").forEach((s, i) => setTimeout(() => {
      const r = s.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) coins(1, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }, 450 + i * 250));
    fresh.clear();
    const near = P().id === "analyst" ? d.near_misses || [] : [];
    $("nearWrap").hidden = !near.length;
    $("near").innerHTML = near.length ? `<table><thead><tr><th>Spiel</th><th>Wette</th><th class="num">Quote</th><th class="num">Unsere Wkt.</th><th class="num">Vorteil</th></tr></thead><tbody>${near.map((n) =>
      `<tr><td>${esc(n.home)} – ${esc(n.away)}<br><small>${esc(n.league)}, ${wd(n.commence)} ${hhmm(n.commence)}</small></td><td>${esc(n.label)}</td><td class="num">${odds(n.odds)}<br><small>${esc(n.book_name)}</small></td><td class="num">${pct(n.p)}</td><td class="num">${pct(n.ev, true)}</td></tr>`).join("")}</tbody></table>` : "";
  }

  function slip(b) {
    const cls = b.status === "won" ? " s-won" : b.status === "lost" ? " s-lost" : isLive(b) ? " s-live" : "";
    const s = el("article", "slip" + cls);
    const row = el("button", "slip-row");
    row.setAttribute("aria-expanded", open.has(b.id));
    row.innerHTML = `
      <div class="s-time">${wd(b.commence)}<b>${hhmm(b.commence)}</b></div>
      <div class="s-main"><div class="s-league">${esc(b.league)}</div>${b.market === "combo"
        ? `<ul class="legs">${b.legs.map((l) => `<li><span class="lg-st ${l.status === "won" ? "lg-won" : l.status === "lost" ? "lg-lost" : ""}">${l.status === "won" ? "✓" : l.status === "lost" ? "✗" : "·"}</span>${esc(l.home)} – ${esc(l.away)}: ${esc(l.label)} (${odds(l.odds)})</li>`).join("")}</ul>`
        : `<div class="s-match">${esc(b.home)} – ${esc(b.away)}</div>`}
        <div class="s-pick">${esc(b.label)}${b.kind === "filler" ? `<span class="s-filler">Füllwette</span>` : ""}</div></div>
      <div class="s-odds"><b>${odds(b.odds)}</b><span>${esc(b.book_name)}</span>${b.ev > 0 ? `<span class="s-edge" title="Erwartungswert">${pct(b.ev, true)}</span>` : ""}</div>
      <div class="s-stake"><b>${eur0(b.stake)}</b><span>möglich ${eur(b.potential_payout)}</span></div>
      <div class="s-state">${stamp(b)}<span class="s-chev" aria-hidden="true"></span></div>`;
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
    const rows = entries.map(([bk, v], i) => {
      const hl = bk === b.book_name || bk === "Tipico" || bk === "Pinnacle";
      return `<span class="bk ${hl ? "hl" : ""}">${esc(bk)}</span><span class="bbar ${bk === b.book_name ? "best" : ""} ${fairPos != null ? "fair" : ""}" style="--fair:${fairPos}%;--i:${i}"><i style="width:${w(v)}%"></i></span><span class="bv">${odds(v)}</span>`;
    }).join("");
    const right = `<div><h4>Quotenvergleich für „${esc(b.label)}“</h4><div class="books">${rows}</div>
      <p class="books-note"><span class="fair-key"></span>Faire Quote ${odds(fairO)}. Alles rechts davon ist eine Wette mit Vorteil.${b.tipico_odds ? ` Tipico bot ${odds(b.tipico_odds)}.` : ""}</p></div>`;
    return left + right;
  }

  // ------------------------------------------------------------------ Live-Bereich (Startseite)
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const unitsOf = (g) => (g === "Fußball" || g === "Eishockey" ? ["Tor", "Tore"] : ["Punkt", "Punkte"]);
  const clockDe = (m) => {
    if (/HALFTIME/.test(m.name || "") || /^(HT|Halftime)$/i.test(m.detail || "")) return "Halbzeit";
    return (m.detail || "").replace(/^FT$/, "Abpfiff").replace(/^Final.*/, "Abpfiff").replace(/^End of /, "Ende ").replace(/ Quarter$/, ". Viertel");
  };
  function gameProgress(e, m) {
    if (m.state !== "in") return m.state === "post" ? 100 : 0;
    if (/HALFTIME/.test(m.name || "")) return 50;
    if (e.group === "Fußball") return Math.min(100, ((parseInt(m.clock, 10) || 0) / 90) * 100);
    const periods = e.group === "Eishockey" ? 3 : 4;
    const len = e.group === "Eishockey" ? 20 : e.group === "American Football" ? 15 : e.league === "EuroLeague" ? 10 : 12;
    const [mm, ss] = String(m.clock || "0:00").split(":").map(Number);
    const left = (mm || 0) + (ss || 0) / 60;
    return Math.min(100, Math.max(0, (((m.period || 1) - 1 + (1 - left / len)) / periods) * 100));
  }
  function betStory(p, e, hs, as) {
    const g = grade(p, hs, as);
    const [one, many] = unitsOf(e.group);
    let text = "";
    if (p.market === "h2h") {
      if (p.key === "draw") {
        const d = Math.abs(hs - as);
        text = d ? `${plural(d, one, many)} bis zum Ausgleich` : "Steht unentschieden";
      } else {
        const d = p.key === "home" ? hs - as : as - hs;
        text = d > 0 ? `Führt mit ${plural(d, one === "Tor" ? "Tor" : "Punkt", one === "Tor" ? "Toren" : "Punkten")}` : d < 0 ? `Liegt ${plural(-d, one, many)} zurück` : "Noch kein Vorsprung";
      }
    } else if (p.market === "totals") {
      const t = hs + as, pt = p.point;
      if (p.key === "over") {
        const need = Math.floor(pt) + 1 - t;
        text = t > pt ? "Linie ist schon geknackt" : `Noch ${plural(need, one, many)} nötig`;
      } else if (t > pt) text = "Linie ist überschritten";
      else {
        const left = Math.ceil(pt) - 1 - t;
        text = left > 0 ? `Noch ${plural(left, one, many)} Luft` : `Kein weiteres ${one} erlaubt`;
      }
    } else if (p.market === "spreads") {
      const m = (hs - as + p.point) * (p.key === "home" ? 1 : -1);
      text = m > 0 ? `Handicap ${plural(Math.ceil(m), one, many)} im Plus` : m < 0 ? `Handicap ${plural(Math.ceil(-m), one, many)} im Minus` : "Handicap genau getroffen";
    }
    const profit = p.combo ? null : g === "won" ? p.stake * (p.odds - 1) : g === "lost" ? -p.stake : 0;
    return { g, text, profit };
  }
  const shortName = (id) => pName(id).replace(/^Der /, "");
  function oddsChip(p, e, m) {
    const c = state.players[p.player].color;
    const head = `<span class="oc-who" style="--c:${c}">${esc(shortName(p.player))}</span><span class="oc-odds">${odds(p.odds)}</span><span class="oc-tip">${esc(p.label)}</span>`;
    if (!m || m.state === "pre") return `<div class="oc">${head}<span class="oc-state">${p.combo ? `Teil der ${esc(p.combo)}` : `${eur0(p.stake)} Einsatz`}</span></div>`;
    const s = betStory(p, e, m.home_score, m.away_score);
    const cls = s.g === "won" ? "up" : s.g === "lost" ? "down" : "";
    const res = p.combo ? (s.g === "won" ? "passt" : s.g === "lost" ? "wackelt" : "offen") : s.g === "push" ? "0,00 €" : eur(s.profit, true);
    return `<div class="oc ${cls}">${head}<span class="oc-state"><span>${esc(s.text)}</span><b>${s.g === "won" ? "▲" : s.g === "lost" ? "▼" : "■"} ${res}</b></span></div>`;
  }
  function eventRow(e, goals) {
    const m = e.espn ? matches[e.espn.id] : null;
    const isLive = m?.state === "in", post = m?.state === "post";
    const started = new Date(e.commence).getTime() <= Date.now();
    const goal = goals.has(e.key);
    let state_;
    if (isLive) state_ = `<span class="badge-live">Live</span><span class="ev-clock">${esc(clockDe(m))}</span>`;
    else if (post) state_ = `<span class="ev-final">Abpfiff</span><span class="ev-sub">wird abgerechnet</span>`;
    else if (started) state_ = `<span class="ev-final">Läuft</span><span class="ev-sub">kein Live-Stand</span>`;
    else state_ = `<span class="ev-time">${hhmm(e.commence)}</span><span class="ev-sub" data-countdown="${e.commence}">${countdownText(e.commence)}</span>`;
    const score = (v) => (isLive || post ? `<b class="ev-score ${goal ? "score-pop" : ""}">${v}</b>` : "");
    return `<article class="ev ${isLive ? "is-live" : ""} ${goal ? "goal-flash" : ""}" id="m-${esc(e.key)}">
      <div class="ev-state">${state_}</div>
      <div class="ev-teams">
        <div class="ev-team">${teamBadge(e.home, m, "home")}<span>${esc(e.home)}</span>${score(m?.home_score)}</div>
        <div class="ev-team">${teamBadge(e.away, m, "away")}<span>${esc(e.away)}</span>${score(m?.away_score)}</div>
        ${isLive ? `<div class="ev-progress" aria-hidden="true"><i style="width:${gameProgress(e, m).toFixed(0)}%"></i></div>` : ""}
      </div>
      <div class="ev-bets">${e.picks.map((p) => oddsChip(p, e, m)).join("")}</div>
    </article>`;
  }
  function renderHub(goals = new Set()) {
    if (!state) return;
    const pid = state.players[view] ? view : null;
    const all = matchEntries(pid);
    const st = (e) => (e.espn && matches[e.espn.id] ? matches[e.espn.id].state : null);
    const rank = (e) => (st(e) === "in" ? 0 : st(e) === "post" ? 2 : new Date(e.commence) <= new Date() ? 1 : 3);
    const visible = all.filter((e) => inPlayWindow(e) || new Date(e.commence) > new Date());
    const groups = ["Fußball", "Basketball", "Eishockey", "American Football"].filter((g) => visible.some((e) => e.group === g));
    if (sportFilter !== "Alle" && !groups.includes(sportFilter)) sportFilter = "Alle";
    const liveCount = (g) => visible.filter((e) => st(e) === "in" && (g === "Alle" || e.group === g)).length;
    $("sportChips").innerHTML = ["Alle", ...groups].map((g) => {
      const n = visible.filter((e) => g === "Alle" || e.group === g).length, l = liveCount(g);
      return `<button type="button" class="chip" role="tab" aria-selected="${g === sportFilter}" data-g="${g}">${g === "American Football" ? "Football" : g}<span>${n}</span>${l ? `<em>${l} live</em>` : ""}</button>`;
    }).join("");
    $("sportChips").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { sportFilter = b.dataset.g; renderHub(); }));
    const sorted = visible.filter((e) => sportFilter === "Alle" || e.group === sportFilter).sort((a, b) => rank(a) - rank(b) || a.commence.localeCompare(b.commence));
    const liveN = sorted.filter((e) => rank(e) < 3).length;
    const limit = pid || showAllEvents ? sorted.length : liveN + 6;
    const list = sorted.slice(0, limit);
    const byLeague = new Map();
    for (const e of list) { const k = `${rank(e) === 0 ? 0 : 1}|${e.league}`; if (!byLeague.has(k)) byLeague.set(k, []); byLeague.get(k).push(e); }
    $("hubTrack").innerHTML = list.length ? [...byLeague.entries()].map(([k, evs]) => `<section class="ev-group"><h3 class="ev-league"><span>${esc(evs[0].league)}</span><span>${k[0] === "0" ? "Live" : plural(evs.length, "Spiel", "Spiele")}</span></h3>${evs.map((e) => eventRow(e, goals)).join("")}</section>`).join("")
      : `<p class="hub-empty">Gerade laufen keine Wetten. Die nächsten werden täglich um 11:00 Uhr gesetzt.</p>`;
    if (!pid && sorted.length > liveN + 6) {
      const more = el("button", "ev-more", showAllEvents ? "Weniger Spiele zeigen" : `Alle ${sorted.length} Spiele zeigen`);
      more.type = "button";
      more.addEventListener("click", () => { showAllEvents = !showAllEvents; renderHub(); });
      $("hubTrack").appendChild(more);
    }
    const running = visible.filter((e) => st(e) === "in");
    $("hubDot").hidden = !running.length;
    $("hubTitleText").textContent = running.length ? plural(running.length, "Spiel", "Spiele") : "Nächste Spiele";
    let sum = 0, stake = 0;
    for (const e of running) {
      const m = matches[e.espn.id];
      for (const p of e.picks) if (!p.combo) { sum += betStory(p, e, m.home_score, m.away_score).profit; stake += p.stake; }
    }
    $("hubSum").innerHTML = running.length
      ? `Stand jetzt <b class="${sum > 0 ? "lb-pos" : sum < 0 ? "lb-neg" : ""}">${eur(sum, true)}</b> bei ${eur0(stake)} Einsatz`
      : "";
    renderSlipRail();
  }

  // ------------------------------------------------------------------ Können/Glück, Methode, System
  function renderSkill() {
    const t = P().totals;
    const expSettled = myBets().filter((b) => b.status !== "open").reduce((a, b) => a + (b.ev || 0) * b.stake, 0);
    const items = [
      ["Ø Closing Line Value", t.avg_clv == null ? "–" : pct(t.avg_clv, true), t.n_clv ? `aus ${t.n_clv} Schlusskursen` : "noch keine Schlusskurse"],
      ["Besser als Schlusskurs", t.n_clv ? `${t.clv_positive} von ${t.n_clv}` : "–", "Wetten mit echtem Vorteil"],
      ["Ø Erwartungswert", t.avg_ev == null ? "–" : pct(t.avg_ev, true), "beim Platzieren, nach Einsatz gewichtet"],
      ["Echt minus erwartet", t.staked_settled ? eur(t.profit - expSettled, true) : "–", "positiv: Glück auf unserer Seite"],
    ];
    $("skillStats").innerHTML = items.map(([k, v, s]) => `<div><dt>${k}</dt><dd>${v}<small>${s}</small></dd></div>`).join("");
  }

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
      return { league: m.league, gain: base - best[1] };
    });
    const names = { D1: "Bundesliga", E0: "Premier League", D2: "2. Bundesliga", E1: "Championship", SP1: "La Liga", I1: "Serie A" };
    $("evidence").innerHTML = `<h3>Was der Backtest zeigt</h3>
      ${svs ? `<p>Die Kernstrategie haben wir an der Saison 2024/25 getestet: Pinnacle-Quote entmargen und bei der besten Quote am Markt wetten, wenn der Vorteil über 2 % liegt. Das ergab in 10 Ligen ${svs.bets} Wetten mit <strong>${pct(svs.roi, true)} Rendite</strong>. Im Schnitt lag die Quote ${pct(svs.clv)} über dem fairen Schlusskurs.</p>` : ""}
      <p>Das Tor-Modell allein hat den Markt in der Saison 2025/26 nicht geschlagen. Den Log-Loss der Pinnacle-Schlussquote verbessert es nur in ${ll.filter((x) => x.gain > 0.0001).map((x) => names[x.league] || x.league).join(", ") || "keiner Liga"}. Deshalb bekommt es nur ein kleines Gewicht. Den größten Teil des Vorteils liefert der Quotenvergleich, nicht die eigene Prognose.</p>`;
  }

  function renderSys() {
    const s = state.system || {};
    const parts = [`Stand der Daten: ${fmt(state.generated_at, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} Uhr`];
    if (s.credits_remaining != null) parts.push(`Quoten-API: ${s.credits_remaining} von 500 Abrufen übrig`);
    const la = (s.last_actions || []).at(-1);
    if (la) parts.push(`Letzte Aktion: ${la.a} (${hhmm(la.t)} Uhr)`);
    $("sys").textContent = parts.join(". ") + ".";
  }

  // ------------------------------------------------------------------ Spieler-Tabs & Vergleich
  const ranked = () => state.order.map((id) => state.players[id])
    .sort((a, b) => (b.totals.profit - a.totals.profit) || ((b.totals.expected_profit || 0) - (a.totals.expected_profit || 0)));

  function setView(v) {
    view = v;
    history.replaceState(null, "", v === "vergleich" ? location.pathname : `#${v}`);
    selectedDay = null;
    open.clear();
    firstRender = true;
    render();
    firstRender = false;
    pollLive();
  }

  function renderTabs() {
    const box = $("tabs");
    const tabs = [["vergleich", "Vergleich", null], ...state.order.map((id) => [id, state.players[id].name, state.players[id]])];
    box.innerHTML = tabs.map(([id, name, pl]) => {
      const t = pl?.totals;
      const val = t && t.staked_settled ? `<b class="${t.profit > 0 ? "t-pos" : t.profit < 0 ? "t-neg" : ""}">${eur(t.profit, true)}</b>` : "";
      return `<button class="tab" role="tab" aria-selected="${id === view}" data-v="${id}" style="--c:${pl ? pl.color : "#fff"}">${pl ? "<i></i>" : ""}${esc(name)} ${val}</button>`;
    }).join("");
    box.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { setView(b.dataset.v); window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }); }));
    const act = box.querySelector('.tab[aria-selected="true"]');
    if (act) box.scrollTo({ left: act.offsetLeft - box.clientWidth / 2 + act.clientWidth / 2, behavior: firstRender ? "auto" : "smooth" });
  }

  function renderCompare() {
    const rows = ranked();
    const anyBets = rows.some((p) => p.totals.n_bets);
    const head = `<div class="lb-row lb-head" role="row"><span class="lb-rank">#</span><span>Spieler</span><span class="lb-num">Kontostand</span><span class="lb-num lb-roi">Rendite</span><span class="lb-num lb-hide-s">Treffer</span><span class="lb-num lb-hide-m lb-hide-s">Ø Quote</span><span class="lb-num lb-hide-m lb-hide-s">Größter Rückgang</span></div>`;
    $("leaderboard").innerHTML = head + rows.map((p, i) => {
      const t = p.totals;
      const cls = t.profit > 0.004 ? "lb-pos" : t.profit < -0.004 ? "lb-neg" : "";
      return `<div class="lb-row is-link ${anim("slide-in")}" role="row" data-v="${p.id}" style="--d:${i * 80}ms">
        <span class="lb-rank">${anyBets ? i + 1 : "–"}</span>
        <span class="lb-name" style="--c:${p.color}"><i></i><span><b>${esc(p.name)}</b><small>Risiko ${esc(p.risk)}<span class="lb-tagline">. ${esc(p.tagline)}</span></small></span></span>
        <span class="lb-num big ${cls}">${t.staked_settled ? eur(t.profit, true) : "–"}<small class="lb-sub">${t.roi == null ? "" : `Rendite ${pct(t.roi, true)}`}</small></span>
        <span class="lb-num lb-roi ${cls}">${t.roi == null ? "–" : pct(t.roi, true)}</span>
        <span class="lb-num lb-hide-s">${t.won + t.lost ? `${t.won}<small>von ${t.won + t.lost}</small>` : "–"}</span>
        <span class="lb-num lb-hide-m lb-hide-s">${t.avg_odds ? odds(t.avg_odds) : "–"}</span>
        <span class="lb-num lb-hide-m lb-hide-s">${t.staked_settled ? eur(-t.max_drawdown) : "–"}</span></div>`;
    }).join("");
    $("leaderboard").querySelectorAll(".lb-row.is-link").forEach((r) => r.addEventListener("click", () => setView(r.dataset.v)));
    renderCompareChart();
    renderRiskChart();
    $("playerCards").innerHTML = state.order.map((id) => {
      const p = state.players[id], t = p.totals;
      return `<article class="pcard" style="--c:${p.color}"><h3>${esc(p.name)} <small>Risiko ${esc(p.risk)}</small></h3>
        <p class="pc-tag">${esc(p.tagline)}</p>
        <details class="pc-desc"><summary>So spielt er</summary><p>${esc(p.desc)}</p></details>
        <div class="pc-stats"><span><b>${t.n_bets}</b>Wetten</span><span><b>${t.staked_settled ? eur(t.profit, true) : "–"}</b>Ergebnis</span><span><b>${t.avg_ev == null ? "–" : pct(t.avg_ev, true)}</b>Ø Erwartung</span></div>
        <button class="linkish" data-v="${id}">Alle Wetten ansehen</button></article>`;
    }).join("");
    $("playerCards").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { setView(b.dataset.v); window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }); }));
  }

  function renderCompareChart() {
    const box = $("compareChart");
    box.innerHTML = "";
    const today = berlinDate();
    // Punkte: Start (0) + Ende jedes Tages, der schon Ergebnisse hat
    const lastIdx = Math.max(-1, ...state.order.map((id) => state.players[id].days.reduce((m, d, i) => (d.settled ? i : m), -1)));
    if (lastIdx < 0) {
      box.innerHTML = `<div class="chart-empty">Sobald die ersten Wetten abgerechnet sind, läuft hier für jeden Spieler eine Linie: Wer liegt vorn?</div>`;
      $("compareLegend").innerHTML = "";
      return;
    }
    const n = lastIdx + 1;
    const lines = state.order.map((id) => { const p = state.players[id]; return { p, v: [0, ...p.days.slice(0, n).map((d) => d.cum_profit)] }; });
    const W = box.clientWidth || 700, H = box.clientHeight || 280;
    const narrow = W < 520;
    const m = { l: narrow ? 44 : 52, r: narrow ? 12 : 124, t: 12, b: 26 };
    const { lo, hi, step } = scale(lines.flatMap((l) => l.v));
    $("compareLegend").innerHTML = [...lines].sort((a, b) => b.v[n] - a.v[n]).map((l) => `<span style="--c:${l.p.color}"><i></i>${esc(l.p.name.replace("Der ", ""))} <b>${eur(l.v[n], true)}</b></span>`).join("");
    const x = (i) => m.l + (i / n) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    let s = gridAxis(lo, hi, step, y, m, W, " €") + `<g class="axis">`;
    s += `<text x="${x(0)}" y="${H - 6}" text-anchor="middle">Start</text>`;
    for (let i = 1; i <= n; i++) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${wd(state.days[i - 1].date + "T12:00:00")}</text>`;
    s += `</g><line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    // Endlabels ohne Überlappung
    const ends = lines.map((l) => ({ l, y: y(l.v[n]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    lines.forEach((l) => {
      const d = l.v.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      s += `<path class="${anim("draw")}" d="${d}" fill="none" stroke="${l.p.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      s += `<circle cx="${x(n)}" cy="${y(l.v[n])}" r="4" fill="${l.p.color}" class="hoverdot"/>`;
    });
    if (!narrow) ends.forEach((e) => { s += `<text class="lbl" x="${x(n) + 10}" y="${e.y + 4}"><tspan class="lbl-strong">${eur(e.l.v[n], true)}</tspan> ${esc(e.l.p.name.replace("Der ", ""))}</text>`; });
    s += `<g class="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${H - m.b}"/></g>`;
    const { svg, tip } = svgIn(box, W, H, s);
    svg.querySelectorAll(".draw").forEach((p) => p.style.setProperty("--len", p.getTotalLength()));
    const hover = svg.querySelector(".hover");
    svg.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n, Math.round(((px - m.l) / (W - m.l - m.r)) * n)));
      hover.style.display = "";
      hover.querySelector(".cross").setAttribute("x1", x(i)); hover.querySelector(".cross").setAttribute("x2", x(i));
      tip.hidden = false;
      tip.style.left = `${(x(i) / W) * 100}%`; tip.style.top = `${(m.t / H) * 100 + 8}%`;
      const label = i ? `Nach Tag ${i}` : "Start";
      tip.innerHTML = `${label}<br>` + [...lines].sort((a, b) => b.v[i] - a.v[i]).map((l) => `<span style="color:${l.p.color}">●</span> ${esc(l.p.name)}: <b>${eur(l.v[i], true)}</b>`).join("<br>");
      tip.style.transform = "translate(-50%, 0)";
    });
    svg.addEventListener("pointerleave", () => { hover.style.display = "none"; tip.hidden = true; });
    void today;
  }

  function renderRiskChart() {
    const box = $("riskChart");
    box.innerHTML = "";
    const pl = state.order.map((id) => state.players[id]).filter((p) => p.totals.staked_settled);
    if (!pl.length) { box.innerHTML = `<div class="chart-empty">Zeigt nach den ersten Ergebnissen, welche Strategie wie viel Rendite für wie viel Risiko bringt.</div>`; return; }
    const W = box.clientWidth || 340, H = box.clientHeight || 280;
    const m = { l: 50, r: 16, t: 14, b: 30 };
    const rois = pl.map((p) => p.totals.roi * 100), dds = pl.map((p) => p.totals.max_drawdown);
    const ys = scale(rois);
    const xmax = niceStep(Math.max(...dds, 10) / 4) * 4;
    const x = (v) => m.l + (v / xmax) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - ys.lo) / (ys.hi - ys.lo)) * (H - m.t - m.b);
    let s = gridAxis(ys.lo, ys.hi, ys.step, y, m, W, " %") + `<g class="axis">`;
    for (let v = 0; v <= xmax + 1e-9; v += xmax / 4) s += `<text x="${x(v)}" y="${H - 8}" text-anchor="middle">${Math.round(v)} €</text>`;
    s += `</g><line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    // Beschriftungen ohne Überlappung: nach y sortieren und auseinanderschieben
    const pts = pl.map((p, i) => ({ p, i, cx: x(p.totals.max_drawdown), cy: y(p.totals.roi * 100) }));
    const lab = [...pts].sort((a, b) => a.cy - b.cy);
    lab.forEach((q, k) => { q.ly = q.cy; if (k && q.ly - lab[k - 1].ly < 14 && Math.abs(q.cx - lab[k - 1].cx) < 110) q.ly = lab[k - 1].ly + 14; });
    pts.forEach(({ p, i, cx, cy, ly }) => {
      s += `<circle class="mark" data-i="${i}" cx="${cx}" cy="${cy}" r="7" fill="${p.color}" stroke="var(--sheet)" stroke-width="2"/>`;
      const right = cx > W - 100;
      s += `<text class="lbl" x="${cx + (right ? -12 : 12)}" y="${ly + 4}" text-anchor="${right ? "end" : "start"}">${esc(p.name.replace("Der ", ""))}</text>`;
      s += `<circle class="hit" data-i="${i}" data-x="${cx}" data-y="${cy - 6}" cx="${cx}" cy="${cy}" r="16"/>`;
    });
    const { svg, tip } = svgIn(box, W, H, s);
    bindMarkTips(svg, tip, W, H, (i) => {
      const t = pl[i].totals;
      return `<b>${esc(pl[i].name)}</b><br>Rendite ${pct(t.roi, true)}, Ergebnis ${eur(t.profit, true)}<br>größter Rückgang ${eur(-t.max_drawdown)}`;
    });
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
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (!state) return; if (view === "vergleich") { renderCompareChart(); renderRiskChart(); } else { renderChart(); renderDayChart(); renderClv(); } }, 150);
  });
  setInterval(() => document.querySelectorAll("[data-countdown]").forEach((n) => { n.textContent = countdownText(n.dataset.countdown); }), 1000);
  load();
  setInterval(load, 60_000);
  setInterval(pollLive, 20_000);
  const sbV = $("sbView");
  sbV.addEventListener("pointerenter", () => { sbPaused = true; });
  sbV.addEventListener("pointerleave", () => { sbPaused = false; sbLast = 0; });
  if (!REDUCED) requestAnimationFrame(sbFrame); else sbV.style.overflowX = "auto";
})();
