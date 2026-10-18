/*
 * Know Your City — data engine
 * Pure functions (no DOM, no network) so they can be tested in Node.
 *
 * Works on ACS 5-year Data Profile tables (DP02, DP03, DP04, DP05).
 * Variable naming: DPxx_nnnn + E (estimate) / M (margin of error)
 *                              PE (percent)  / PM (percent margin of error)
 */
(function (root) {
  "use strict";

  var NA_LIMIT = -100000000; // Census sentinels (-666666666, -888888888 ...) are all below this
  var Z90 = 1.645;           // Census MOEs are published at 90% confidence
  var Z95 = 1.96;

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    if (isNaN(n) || n < NA_LIMIT) return null;
    return n;
  }

  // vars: { "DP04_0047E": {label: "Estimate!!HOUSING TENURE!!..."}, ... }  (from the groups/DPxx.json endpoints)
  function buildItems(vars) {
    var items = {};
    Object.keys(vars).forEach(function (id) {
      var m = id.match(/^(DP\d{2}_\d{4})(E|PE)$/);
      if (!m) return;
      var it = items[m[1]] || (items[m[1]] = { base: m[1] });
      var label = (vars[id] && vars[id].label) || "";
      if (m[2] === "E") it.estLabel = label; else it.pctLabel = label;
    });
    Object.keys(items).forEach(function (k) {
      var it = items[k];
      var lab = (it.estLabel || it.pctLabel || "").replace(/^(Estimate|Percent)!!/, "");
      it.segs = lab.split("!!");
      it.topic = it.segs[0] || "";
      it.last = it.segs[it.segs.length - 1] || "";
      it.denom = it.segs.length >= 3 ? it.segs[1] : it.topic;
      it.search = it.segs.join("!!").toLowerCase();
    });
    return items;
  }

  function getVals(row, base) {
    return {
      e: num(row[base + "E"]), em: num(row[base + "M"]),
      p: num(row[base + "PE"]), pm: num(row[base + "PM"])
    };
  }

  var VAL_RE = /(median|mean|per capita|average)/i;

  // Compare one item for a place against the U.S. Returns null when it can't be compared.
  function compare(it, placeRow, usRow) {
    var a = getVals(placeRow, it.base), b = getVals(usRow, it.base);
    var type = null, p, pus, m, mus;
    if (it.pctLabel && a.p !== null && b.p !== null && b.p > 0 && b.p < 99.5) {
      type = "pct"; p = a.p; pus = b.p; m = a.pm; mus = b.pm;
    } else if (it.estLabel && VAL_RE.test(it.last + " " + it.segs.join(" ")) &&
               a.e !== null && b.e !== null && b.e > 0) {
      type = "val"; p = a.e; pus = b.e; m = a.em; mus = b.em;
    } else {
      return null;
    }
    return finish(type, it, p, pus, m, mus);
  }

  // Shared significance math. type: "pct" | "val" | "ratio"
  function finish(type, it, p, pus, m, mus) {
    var se = (m === null || m === undefined ? 0 : m) / Z90;
    var seUs = (mus === null || mus === undefined ? 0 : mus) / Z90;
    var denom = Math.sqrt(se * se + seUs * seUs);
    var z = denom > 0 ? (p - pus) / denom : 0;
    var rel = type === "pct" ? Math.abs(Math.log((p + 1) / (pus + 1))) : Math.abs(Math.log(p / pus));
    var cv = (m !== null && m !== undefined && p > 0) ? (m / Z90) / p : 0; // coefficient of variation of the place estimate
    return {
      item: it, type: type, p: p, pus: pus, m: m, mus: mus,
      z: z, rel: rel, diff: p - pus, cv: cv,
      sig: denom > 0 && Math.abs(z) >= Z95,
      ratio: p / pus
    };
  }

  var TOPIC_SKIP = /SMOC|^RACE$|GRAPI|CITIZEN VOTING/i;
  var LAST_SKIP = /^(total|occupied housing units|not computed)/i;

  function isStandoutEligible(c) {
    var it = c.item;
    if (TOPIC_SKIP.test(it.topic)) return false;
    if (LAST_SKIP.test(it.last)) return false;
    if (/Not Hispanic or Latino/i.test(it.search)) return false;
    if (!c.sig) return false;
    if (c.cv > 0.3) return false;                 // too noisy to brag about
    if (c.type === "pct") {
      if (c.p < 1 && c.pus < 1) return false;     // trivial slivers
      if (Math.abs(c.diff) < 2) return false;     // at least 2 percentage points
      if (c.rel < 0.2) return false;              // and about 22% relative difference
    } else {
      if (c.rel < 0.15) return false;
    }
    return true;
  }

  // Top-N most notable, statistically significant differences, one per topic so the list stays varied.
  // `extra` = additional pre-computed comparisons (e.g. S2501 ownership findings) to compete in the same ranking.
  function pickStandouts(items, placeRow, usRow, n, extra) {
    var all = [];
    Object.keys(items).forEach(function (k) {
      var c = compare(items[k], placeRow, usRow);
      if (c && isStandoutEligible(c)) all.push(c);
    });
    (extra || []).forEach(function (c) { if (c && isStandoutEligible(c)) all.push(c); });
    all.sort(function (x, y) { return y.rel - x.rel; });
    var out = [], seen = {};
    for (var i = 0; i < all.length && out.length < (n || 3); i++) {
      var t = all[i].item.topic;
      if (seen[t]) continue;
      seen[t] = true;
      out.push(all[i]);
    }
    return out;
  }

  // Find the first item whose label contains every term (case-insensitive).
  function findItem(items, terms) {
    var t = terms.map(function (s) { return s.toLowerCase(); });
    var keys = Object.keys(items).sort();
    for (var i = 0; i < keys.length; i++) {
      var it = items[keys[i]], ok = true;
      for (var j = 0; j < t.length; j++) if (it.search.indexOf(t[j]) === -1) { ok = false; break; }
      if (ok) return it;
    }
    return null;
  }

  function cleanTopic(s) {
    s = (s || "").replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Human-friendly title/subtitle for engine-picked items.
  function describe(c) {
    var it = c.item, title, sub;
    if (it.title) return { title: it.title, sub: it.sub || "" };
    if (c.type === "val") {
      if (/^median \(dollars\)$/i.test(it.last)) title = "Median " + cleanTopic(it.topic).toLowerCase();
      else title = it.last;
      sub = it.denom && it.denom !== it.topic ? it.denom : cleanTopic(it.topic);
    } else {
      title = it.last;
      sub = "of " + it.denom.toLowerCase() + " · " + cleanTopic(it.topic).toLowerCase();
    }
    return { title: title, sub: sub };
  }

  function unitFor(it) {
    var s = it.search;
    if (/dollars/.test(s)) return "$";
    if (/minutes/.test(s)) return "min";
    if (/years\)/.test(s) || /median age/.test(s)) return "yrs";
    if (/average (household|family) size/.test(s)) return "ppl";
    return "";
  }

  function fmtNumber(v, dec) {
    return Number(v).toLocaleString("en-US", { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }

  function fmt(c, v) {
    if (c.type === "ratio") return v.toFixed(1) + "×";
    if (c.type === "pct") return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + "%";
    var u = unitFor(c.item);
    if (u === "$") return "$" + fmtNumber(v, 0);
    if (u === "min") return v.toFixed(1) + " min";
    if (u === "yrs") return v.toFixed(1) + " yrs";
    if (u === "ppl") return v.toFixed(2);
    return fmtNumber(v, v < 100 ? 1 : 0);
  }

  function ratioText(c) {
    if (!c.sig) return "about the U.S. average";
    var r = c.ratio;
    if (r >= 1) return r >= 1.5 ? r.toFixed(1) + "× the U.S." : Math.round((r - 1) * 100) + "% above U.S.";
    return Math.round((1 - r) * 100) + "% below U.S.";
  }

  // Turn "Place Name city, California" into pieces.
  function splitCensusName(name) {
    var i = (name || "").lastIndexOf(",");
    return { place: i > -1 ? name.slice(0, i).trim() : name, state: i > -1 ? name.slice(i + 1).trim() : "" };
  }

  // Neutrality filter: Know Your City is descriptive only. Skip fun-fact text about partisan politics,
  // elections, or contested/controversial topics. (Tune this list to taste.)
  var POLITICAL_RE = new RegExp("\\b(" + [
    "republican\\w*", "democrat\\w*", "conservative\\w*", "liberal\\w*", "progressive\\w*", "partisan\\w*",
    "election\\w*", "elected", "voter\\w*", "voted", "voting", "campaign\\w*", "politic\\w*", "senator\\w*",
    "governor\\w*", "president\\w*", "congress\\w*", "legislat\\w*", "party", "parties", "gop",
    "trump", "biden", "obama", "bush", "clinton", "reagan",
    "controvers\\w*", "protest\\w*", "scandal\\w*", "lawsuit\\w*", "abortion\\w*", "gun control",
    "racis\\w*", "segregat\\w*", "klan", "lynch\\w*", "riot\\w*", "massacre\\w*", "sanctuary",
    "immigration policy", "activis\\w*", "left-wing", "right-wing"
  ].join("|") + ")\\b", "i");
  function isNeutralText(s) { return !POLITICAL_RE.test(s || ""); }

  // Break a Wikipedia intro into short, readable "Did you know" sentences.
  function factSentences(text, max) {
    if (!text) return [];
    var clean = text.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
    var parts = clean.split(/(?<=[.!?])\s+(?=[A-Z])/);
    var out = [];
    for (var i = 0; i < parts.length && out.length < (max || 5); i++) {
      var s = parts[i].trim();
      if (s.length < 50 || s.length > 220) continue;
      if (/may refer to|disambiguation/i.test(s)) continue;
      if (!isNeutralText(s)) continue;
      out.push(s);
    }
    return out;
  }

  /* ---------- Subject table S2501 (Occupancy Characteristics): who owns the homes ----------
   * Columns: C01 occupied units, C02 % occupied, C03 owner-occupied, C04 % owner, C05 renter, C06 % renter.
   * Rows are located by label text (not hard-coded row numbers).
   */
  function buildOwnRows(vars) {
    var rows = {};
    Object.keys(vars).forEach(function (id) {
      var m = id.match(/^S2501_C0([13])_(\d{3})E$/);
      if (!m) return;
      var r = rows[m[2]] || (rows[m[2]] = { key: m[2] });
      var segs = (vars[id].label || "").split("!!").slice(2);        // drop "Estimate" and the column name
      if (segs.length && /^occupied housing units$/i.test(segs[0])) segs = segs.slice(1);
      r.segs = segs;
      r[m[1] === "1" ? "c1" : "c3"] = id.slice(0, -1);               // e.g. S2501_C03_019
    });
    Object.keys(rows).forEach(function (k) {
      var r = rows[k];
      if (!r.c1 || !r.c3 || !r.segs.length) { delete rows[k]; return; }
      r.topic = r.segs[0]; r.last = r.segs[r.segs.length - 1];
      r.search = r.segs.join("!!").toLowerCase();
    });
    return rows;
  }

  // Homeownership rate for one row = owners / all occupied units in that group (MOE via Census proportion formula).
  function ownRate(r, row) {
    var n = num(row[r.c3 + "E"]), nm = num(row[r.c3 + "M"]);
    var d = num(row[r.c1 + "E"]), dm = num(row[r.c1 + "M"]);
    if (n === null || d === null || d <= 0) return null;
    var p = n / d, nmv = nm || 0, dmv = dm || 0;
    var under = nmv * nmv - p * p * dmv * dmv;
    var moe = (under > 0 ? Math.sqrt(under) : Math.sqrt(nmv * nmv + p * p * dmv * dmv)) / d;
    return { p: p * 100, m: moe * 100, n: n, d: d };
  }

  // Find a row whose leaf label starts with the term (so "male householder" doesn't match "Female householder").
  function findOwnRow(rows, lastTerm) {
    var t = lastTerm.toLowerCase(), keys = Object.keys(rows).sort();
    for (var i = 0; i < keys.length; i++) {
      if (rows[keys[i]].last.toLowerCase().indexOf(t) === 0) return rows[keys[i]];
    }
    return null;
  }

  function ownItem(r) {
    return {
      base: r.c3, topic: "HOMEOWNERSHIP BY " + r.topic, segs: r.segs, last: r.last,
      denom: "households of this type", search: r.search,
      title: "Homeownership: " + r.last,
      sub: "Share who own their home · " + cleanTopic(r.topic).toLowerCase()
    };
  }

  function compareOwnRate(r, pl, us) {
    var a = ownRate(r, pl), b = ownRate(r, us);
    if (!a || !b || b.p <= 0) return null;
    var c = finish("pct", ownItem(r), a.p, b.p, a.m, b.m);
    c.size = a.d;
    return c;
  }

  // All ownership-rate comparisons for groups that are at least `minShare` of occupied homes.
  function ownCandidates(rows, pl, us, minShare) {
    var total = num(pl.S2501_C01_001E), out = [];
    Object.keys(rows).forEach(function (k) {
      var r = rows[k];
      if (/^householder \d/i.test(r.last)) return;                     // skip age sub-rows (ambiguous on their own)
      var c = compareOwnRate(r, pl, us);
      if (!c) return;
      if (total && c.size / total < (minShare || 0.03)) return;       // too small a group to feature
      out.push(c);
    });
    return out;
  }

  function ratioStat(numR, denR, row) {
    var X = num(row[numR.c3 + "E"]), Xm = num(row[numR.c3 + "M"]);
    var Y = num(row[denR.c3 + "E"]), Ym = num(row[denR.c3 + "M"]);
    if (X === null || Y === null || X <= 0 || Y <= 0) return null;
    var R = X / Y;
    var moe = (1 / Y) * Math.sqrt((Xm || 0) * (Xm || 0) + R * R * (Ym || 0) * (Ym || 0)); // Census ratio formula
    return { p: R, m: moe };
  }

  // e.g. owner households led by a woman (no spouse) per owner household led by a man (no spouse), vs the U.S.
  function compareOwnerRatio(numR, denR, pl, us, item) {
    var a = ratioStat(numR, denR, pl), b = ratioStat(numR, denR, us);
    if (!a || !b) return null;
    return finish("ratio", item, a.p, b.p, a.m, b.m);
  }

  var FM_ITEM = {
    base: "OWN_RATIO_FM", topic: "WHO OWNS", segs: ["Who owns"], last: "Female-led vs male-led owners", denom: "", search: "",
    title: "Women-led vs. men-led homeowners",
    sub: "Owner households headed by a woman with no spouse present, per one headed by a man"
  };
  function femaleMaleOwnerRatio(rows, pl, us) {
    var f = findOwnRow(rows, "female householder, no spouse"), m = findOwnRow(rows, "male householder, no spouse");
    return f && m ? compareOwnerRatio(f, m, pl, us, FM_ITEM) : null;
  }

  var api = {
    isNeutralText: isNeutralText, buildOwnRows: buildOwnRows, ownRate: ownRate, findOwnRow: findOwnRow, compareOwnRate: compareOwnRate,
    ownCandidates: ownCandidates, compareOwnerRatio: compareOwnerRatio, femaleMaleOwnerRatio: femaleMaleOwnerRatio,
    num: num, buildItems: buildItems, getVals: getVals, compare: compare,
    pickStandouts: pickStandouts, findItem: findItem, describe: describe,
    fmt: fmt, ratioText: ratioText, splitCensusName: splitCensusName,
    factSentences: factSentences, cleanTopic: cleanTopic, isStandoutEligible: isStandoutEligible
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.KYC = api;
})(typeof window !== "undefined" ? window : globalThis);
