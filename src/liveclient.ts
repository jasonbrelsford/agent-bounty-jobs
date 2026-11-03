/**
 * Browser side of the dashboard's live activity panel, shipped as inline
 * script strings (the dashboard has no build step or client bundle).
 *
 * LIVE_CORE_JS is pure logic — line formatting and the live/replay state
 * machine — and evaluates to an object, so tests can run it in node without a
 * DOM. LIVE_BOOT_JS binds it to the page and polls GET /v1/events.
 *
 * HONESTY RULE (binding): replayed lines are real past events, always tagged
 * REPLAY, and the header says "Replay · no live activity right now" while they
 * play. Nothing is ever invented. A real new event or request aggregate ends
 * the replay at once and is tagged LIVE. Lines loaded with the page are tagged
 * LOG — real, but not happening now.
 *
 * SECURITY: every string is caller-controlled. The DOM binding only ever uses
 * textContent, never innerHTML.
 */

export const LIVE_IDLE_MS = 10 * 60_000;
export const LIVE_REPLAY_EVERY_MS = 5_000;
export const LIVE_POLL_MS = 4_000;
export const MODE_TEXT = {
  live: "Live activity",
  replay: "Replay · no live activity right now",
  quiet: "Quiet · no live activity right now",
} as const;

export const LIVE_CORE_JS = `(function () {
  var MODE_TEXT = ${JSON.stringify(MODE_TEXT)};
  var KIND_CLASS = {
    agent_registered: "signup", bounty_posted: "posted", submission_received: "sub", team_forming: "sub",
    submission_rejected: "warn", bounty_awarded: "award", bounty_cancelled: "dim", bounty_expired: "dim",
    submission_withdrawn: "warn", poster_unresponsive: "warn", question_asked: "qa", question_answered: "qa",
    delegate_review: "sub", api: "api"
  };
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function utc(iso, now) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "--:--:--Z";
    var t = pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + "Z";
    var n = new Date(now);
    var sameDay = d.getUTCFullYear() === n.getUTCFullYear() && d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() === n.getUTCDate();
    return sameDay ? t : d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " + t;
  }
  function lineFor(ev, tag, now) {
    var extra = [];
    if (ev.question) extra.push("Q \\u203a " + ev.question);
    if (ev.answer) extra.push("A \\u203a " + ev.answer);
    return { tag: tag, cls: KIND_CLASS[ev.kind] || "dim", time: utc(ev.at, now), label: String(ev.label || ev.kind), text: String(ev.text || ""), extra: extra };
  }
  function aggLine(a, tag, now) {
    return { tag: tag, cls: "api", time: utc(a.minute + ":00Z", now).replace(/:00Z$/, "Z"), label: "api", text: a.label + " \\u00b7 " + a.n + " req/min", extra: [] };
  }
  function Controller(view, opts) {
    opts = opts || {};
    var idleMs = opts.idleMs || ${LIVE_IDLE_MS}, everyMs = opts.replayEveryMs || ${LIVE_REPLAY_EVERY_MS};
    var mode = null, lastReal = 0, pool = [], idx = 0, lastReplay = 0;
    function setMode(m) {
      if (m === mode) return;
      mode = m;
      view.setMode(m, MODE_TEXT[m]);
    }
    function idleMode() { return pool.length ? "replay" : "quiet"; }
    return {
      mode: function () { return mode; },
      setPool: function (p) { pool = (p || []).slice(); if (idx >= pool.length) idx = 0; },
      /** Page-load history: real, tagged LOG, and it does not make the panel "live". */
      backlog: function (events, aggs, now) {
        (events || []).forEach(function (e) { view.append(lineFor(e, "LOG", now)); lastReal = Math.max(lastReal, Date.parse(e.at) || 0); });
        (aggs || []).forEach(function (a) { view.append(aggLine(a, "LOG", now)); lastReal = Math.max(lastReal, (Date.parse(a.minute + ":00Z") || 0) + 60000); });
        setMode(now - lastReal >= idleMs ? idleMode() : "live");
        if (mode === "replay") lastReplay = 0;
      },
      /** Anything new from the server is real and current: it ends a replay immediately. */
      live: function (events, aggs, now) {
        events = events || []; aggs = aggs || [];
        if (!events.length && !aggs.length) return;
        setMode("live");
        events.forEach(function (e) { view.append(lineFor(e, "LIVE", now)); });
        aggs.forEach(function (a) { view.append(aggLine(a, "LIVE", now)); });
        lastReal = now;
      },
      tick: function (now) {
        if (mode === null) return;   // nothing loaded yet
        if (mode !== "replay" && now - lastReal >= idleMs) { setMode(idleMode()); lastReplay = 0; }
        if (mode === "quiet" && pool.length) setMode("replay");
        if (mode === "replay" && pool.length && now - lastReplay >= everyMs) {
          view.append(lineFor(pool[idx % pool.length], "REPLAY", now));
          idx = (idx + 1) % pool.length;
          lastReplay = now;
        }
      }
    };
  }
  return { MODE_TEXT: MODE_TEXT, lineFor: lineFor, aggLine: aggLine, utc: utc, Controller: Controller };
})()`;

export const LIVE_BOOT_JS = `(function () {
  var root = document.getElementById("live");
  if (!root || !window.fetch) return;
  var Core = ${LIVE_CORE_JS};
  var log = root.querySelector(".lf-log"), head = root.querySelector(".lf-mode"), status = root.querySelector(".lf-status");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var paused = false;
  function setPaused(p) { paused = p; root.classList.toggle("paused", p); if (!p) log.scrollTop = log.scrollHeight; }
  root.addEventListener("mouseenter", function () { setPaused(true); });
  root.addEventListener("mouseleave", function () { setPaused(false); });
  log.addEventListener("focus", function () { setPaused(true); });
  log.addEventListener("blur", function () { setPaused(false); });
  function span(cls, text) { var s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }
  var view = {
    append: function (l) {
      var row = document.createElement("div");
      row.className = "ln k-" + l.cls + " t-" + l.tag.toLowerCase();
      row.appendChild(span("ts", l.time));
      row.appendChild(document.createTextNode(" "));
      row.appendChild(span("tg", l.tag));
      row.appendChild(document.createTextNode(" "));
      row.appendChild(span("lb", l.label));
      row.appendChild(document.createTextNode(" "));
      row.appendChild(span("tx", l.text));
      l.extra.forEach(function (x) { var d = document.createElement("div"); d.className = "qa"; d.textContent = x; row.appendChild(d); });
      log.appendChild(row);
      while (log.children.length > 150) log.removeChild(log.firstChild);
      if (!paused) log.scrollTo ? log.scrollTo({ top: log.scrollHeight, behavior: reduce ? "auto" : "smooth" }) : (log.scrollTop = log.scrollHeight);
    },
    setMode: function (m, text) {
      root.setAttribute("data-mode", m);
      head.textContent = text;
      // Replays repeat every few seconds; announcing each would flood a screen reader.
      log.setAttribute("aria-live", m === "replay" ? "off" : "polite");
    }
  };
  var c = Core.Controller(view, {});
  var since = null, reqSince = null, delay = ${LIVE_POLL_MS}, skew = 0, poolAt = 0;
  function now() { return Date.now() + skew; }
  function poll() {
    if (document.hidden) { setTimeout(poll, delay); return; }
    var first = since === null, wantPool = first || Date.now() - poolAt > ${LIVE_IDLE_MS};
    var q = [];
    if (!first) q.push("since=" + since);
    if (reqSince) q.push("req_since=" + encodeURIComponent(reqSince));
    if (wantPool) q.push("replay=1");
    fetch("/v1/events?" + q.join("&"), { cache: "no-store" })
      .then(function (r) {
        if (r.status === 429) { delay = 30000; throw new Error("rate limited"); }
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) {
        skew = (Date.parse(d.now) || Date.now()) - Date.now();
        if (d.replay) { c.setPool(d.replay); poolAt = Date.now(); }
        if (first) c.backlog(d.events, d.requests, now()); else c.live(d.events, d.requests, now());
        since = d.next_since; reqSince = d.next_req_since;
        delay = ${LIVE_POLL_MS};
        status.textContent = "connected \\u00b7 polling every 4s \\u00b7 times UTC";
      })
      .catch(function (e) {
        delay = Math.min(Math.max(delay * 2, 8000), 60000);
        status.textContent = (e && e.message === "rate limited" ? "rate limited" : "reconnecting") + " \\u00b7 retry in " + Math.round(delay / 1000) + "s";
      })
      .then(function () { setTimeout(poll, delay); });
  }
  setInterval(function () { c.tick(now()); }, 1000);
  poll();
})();`;
