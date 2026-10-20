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
    if (u === "min") return v.toFixed(1) + (api.lang === "vi" ? " phút" : " min");
    if (u === "yrs") return v.toFixed(1) + (api.lang === "es" ? " años" : api.lang === "fr" ? " ans" : api.lang === "vi" ? " tuổi" : " yrs");
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

  /* ---------- Plain-language sentences (neutral: describe and compare, never judge) ---------- */
  function trimNum(x) { var r = Math.round(x * 10) / 10; return r % 1 === 0 ? String(Math.round(r)) : r.toFixed(1); }

  var FRACTIONS = [
    [0.5, "About half", true], [1 / 3, "About 1 in 3"], [2 / 3, "About 2 in 3"], [0.25, "About 1 in 4"], [0.75, "About 3 in 4"],
    [0.2, "About 1 in 5"], [0.8, "About 4 in 5"], [0.1, "About 1 in 10"], [0.9, "About 9 in 10"],
    [0.4, "About 2 in 5"], [0.6, "About 3 in 5"]
  ];
  // p is a percent (0-100). Returns {t: "About 1 in 4", of: bool} where `of` means "of the" is needed after it.
  var ES_FRAC = { "About half": ["Cerca de la mitad", true, true], "About 1 in 3": ["Alrededor de 1 de cada 3"], "About 2 in 3": ["Alrededor de 2 de cada 3"], "About 1 in 4": ["Alrededor de 1 de cada 4"],
    "About 3 in 4": ["Alrededor de 3 de cada 4"], "About 1 in 5": ["Alrededor de 1 de cada 5"], "About 4 in 5": ["Alrededor de 4 de cada 5"], "About 1 in 10": ["Alrededor de 1 de cada 10"],
    "About 9 in 10": ["Alrededor de 9 de cada 10"], "About 2 in 5": ["Alrededor de 2 de cada 5"], "About 3 in 5": ["Alrededor de 3 de cada 5"] };
  function shareWordsEs(p, g) {
    if (p >= 97) return { t: g === "m" ? "Casi todos" : "Casi todas", of: true };
    for (var i = 0; i < FRACTIONS.length; i++) {
      if (Math.abs(p - FRACTIONS[i][0] * 100) <= 2) { var e = ES_FRAC[FRACTIONS[i][1]]; return { t: e[0], of: !!e[1], de: !!e[2] }; }
    }
    if (p >= 10) return { t: "Alrededor de " + Math.round(p) + " de cada 100", of: false };
    if (p >= 0.5) return { t: "Alrededor de 1 de cada " + Math.round(100 / p), of: false };
    return { t: "Menos de 1 de cada 200", of: false };
  }
  function shareWords(p, g) {
    if (api.lang === "es") return shareWordsEs(p, g);
    if (api.lang === "fr") return { t: usFr(p).replace(/^./, function (m) { return m.toUpperCase(); }), of: false };
    if (api.lang === "vi") return { t: shareVi(p, true).replace(/^./, function (m) { return m.toUpperCase(); }), of: false };
    if (p >= 97) return { t: "Nearly all", of: true };
    for (var i = 0; i < FRACTIONS.length; i++) {
      if (Math.abs(p - FRACTIONS[i][0] * 100) <= 2) return { t: FRACTIONS[i][1], of: !!FRACTIONS[i][2] };
    }
    if (p >= 10) return { t: "About " + Math.round(p) + " in every 100", of: false };
    if (p >= 0.5) return { t: "About 1 in " + Math.round(100 / p), of: false };
    return { t: "Fewer than 1 in 200", of: false };
  }

  // r = place / U.S. for a share of people or things.
  function relCommon(r) {
    if (api.lang === "vi") {
      if (r >= 1.8) return "phổ biến gấp khoảng " + trimNum(r) + " lần";
      if (r >= 1.15) return "phổ biến hơn khoảng " + Math.round((r - 1) * 100) + "%";
      if (r > 0.87) return "phổ biến gần như nhau";
      if (r > 0.5) return "ít phổ biến hơn khoảng " + Math.round((1 - r) * 100) + "%";
      var nv = Math.round(1 / r);
      return "chỉ phổ biến bằng khoảng " + (nv === 2 ? "một nửa" : nv === 3 ? "một phần ba" : nv === 4 ? "một phần tư" : "1/" + nv);
    }
    if (api.lang === "fr") {
      if (r >= 1.8) return "environ " + trimNum(r) + " fois plus courant";
      if (r >= 1.15) return "environ " + Math.round((r - 1) * 100) + "% plus courant";
      if (r > 0.87) return "à peu près aussi courant";
      if (r > 0.5) return "environ " + Math.round((1 - r) * 100) + "% moins courant";
      var nf = Math.round(1 / r);
      return "environ " + (nf === 2 ? "deux fois" : nf === 3 ? "trois fois" : nf === 4 ? "quatre fois" : nf + " fois") + " moins courant";
    }
    if (api.lang === "es") {
      if (r >= 1.8) return "alrededor de " + trimNum(r) + " veces más frecuente";
      if (r >= 1.15) return "alrededor de un " + Math.round((r - 1) * 100) + "% más frecuente";
      if (r > 0.87) return "casi igual de frecuente";
      if (r > 0.5) return "alrededor de un " + Math.round((1 - r) * 100) + "% menos frecuente";
      var ne = Math.round(1 / r);
      return "alrededor de " + (ne === 2 ? "la mitad" : ne === 3 ? "un tercio" : ne === 4 ? "una cuarta parte" : "1/" + ne) + " de frecuente";
    }
    if (r >= 1.8) return "about " + trimNum(r) + " times as common";
    if (r >= 1.15) return "about " + Math.round((r - 1) * 100) + "% more common";
    if (r > 0.87) return "about as common";
    if (r > 0.5) return "about " + Math.round((1 - r) * 100) + "% less common";
    var n = Math.round(1 / r);
    return "about " + (n === 2 ? "half" : n === 3 ? "a third" : n === 4 ? "a quarter" : "1/" + n) + " as common";
  }
  // r = place / U.S. for a dollar amount, age, time...
  function relAbove(r) {
    if (api.lang === "vi") {
      if (r >= 1.8) return "cao gấp khoảng " + trimNum(r) + " lần mức cả nước";
      if (r >= 1.15) return "cao hơn mức cả nước khoảng " + Math.round((r - 1) * 100) + "%";
      if (r > 0.87) return "gần bằng mức cả nước";
      if (r > 0.5) return "thấp hơn mức cả nước khoảng " + Math.round((1 - r) * 100) + "%";
      var nv = Math.round(1 / r);
      return "chỉ bằng khoảng " + (nv === 2 ? "một nửa" : "1/" + nv) + " mức cả nước";
    }
    if (api.lang === "fr") {
      if (r >= 1.8) return "représente environ " + trimNum(r) + " fois le chiffre national";
      if (r >= 1.15) return "se situe environ " + Math.round((r - 1) * 100) + "% au-dessus du chiffre national";
      if (r > 0.87) return "est proche du chiffre national";
      if (r > 0.5) return "se situe environ " + Math.round((1 - r) * 100) + "% en dessous du chiffre national";
      var nf = Math.round(1 / r);
      return "représente environ " + (nf === 2 ? "la moitié" : "1/" + nf) + " du chiffre national";
    }
    if (api.lang === "es") {
      if (r >= 1.8) return "es alrededor de " + trimNum(r) + " veces la cifra nacional";
      if (r >= 1.15) return "está alrededor de un " + Math.round((r - 1) * 100) + "% por encima de la cifra nacional";
      if (r > 0.87) return "está cerca de la cifra nacional";
      if (r > 0.5) return "está alrededor de un " + Math.round((1 - r) * 100) + "% por debajo de la cifra nacional";
      var ne = Math.round(1 / r);
      return "es alrededor de " + (ne === 2 ? "la mitad" : "1/" + ne) + " de la cifra nacional";
    }
    if (r >= 1.8) return "about " + trimNum(r) + " times the national figure";
    if (r >= 1.15) return "about " + Math.round((r - 1) * 100) + "% above the national figure";
    if (r > 0.87) return "close to the national figure";
    if (r > 0.5) return "about " + Math.round((1 - r) * 100) + "% below the national figure";
    var n = Math.round(1 / r);
    return "about " + (n === 2 ? "half" : "1/" + n) + " of the national figure";
  }

  // spec: { subj, pred }  for shares  ("people in {P}", "are under 18")
  //       { main: function(c, P) -> string, usWord }  for medians, ratios and anything custom
  // Returns { main, cmp }: two plain sentences.

  /* French: the shares are said as "environ 1 personne sur 4 à X ..." (singular) or "environ 2 personnes sur 5 ..." (plural), so the sentence is built from
     the spec's fr pieces: n1/np (noun), loc/locp (where), p1/pp (what they do), def (with article, for "presque tous"). The leading \u2060 marks text that is already French,
     so the page can tidy elisions, contractions and spacing on it. */
  var FR_MARK = "\u2060";
  var FR_FRACS = { "About 1 in 3": [1, 3], "About 2 in 3": [2, 3], "About 1 in 4": [1, 4], "About 3 in 4": [3, 4], "About 1 in 5": [1, 5], "About 4 in 5": [4, 5],
    "About 1 in 10": [1, 10], "About 9 in 10": [9, 10], "About 2 in 5": [2, 5], "About 3 in 5": [3, 5] };
  function shareFr(p) {
    if (p >= 97) return { t: "all" };
    for (var i = 0; i < FRACTIONS.length; i++) {
      if (Math.abs(p - FRACTIONS[i][0] * 100) <= 2) { var f = FR_FRACS[FRACTIONS[i][1]]; return f ? { t: "frac", n: f[0], d: f[1] } : { t: "half" }; }
    }
    if (p >= 10) return { t: "frac", n: Math.round(p), d: 100 };
    if (p >= 0.5) return { t: "frac", n: 1, d: Math.round(100 / p) };
    return { t: "lt" };
  }
  function usFr(p) {
    var s = shareFr(p);
    return s.t === "all" ? "presque tous" : s.t === "half" ? "environ la moitié" : s.t === "lt" ? "moins de 1 sur 200" : "environ " + s.n + " sur " + s.d;
  }
  function sentenceFr(c, spec, place) {
    var fr = spec.fr || {}, fill = function (s) { return String(s || "").replace(/\{P\}/g, place); }, main, cmp;
    if (spec.main) main = spec.main(c, place);
    else {
      var s = shareFr(c.p), one = s.t === "lt" || (s.t === "frac" && s.n === 1), where = fill(one ? fr.loc : (fr.locp || fr.loc));
      if (s.t === "all") main = "Presque " + (fr.g === "f" ? "toutes" : "tous") + " " + fill(fr.def) + " " + fr.pp + ".";
      else if (s.t === "half") main = "Environ la moitié des " + fr.np + " " + fill(fr.locp || fr.loc) + " " + fr.pp + ".";
      else if (s.t === "lt") main = "Moins de 1 " + fr.n1 + " sur 200 " + where + " " + fr.p1 + ".";
      else main = "Environ " + s.n + " " + (one ? fr.n1 : fr.np) + " sur " + s.d + " " + where + " " + (one ? fr.p1 : fr.pp) + ".";
    }
    if (spec.cmp) cmp = spec.cmp(c, place);
    else if (c.type === "pct") {
      var clearGap = c.sig && (c.ratio >= 1.15 || c.ratio <= 0.87);
      cmp = "À l'échelle nationale, le chiffre est " + usFr(c.pus) + (clearGap ? ", ce qui le rend " + relCommon(c.ratio) + " à " + place + "." : ", donc " + place + " ressemble beaucoup aux États-Unis sur ce point.");
    } else {
      cmp = (spec.usWordFr || "Le chiffre national") + " est " + fmt(c, c.pus) + ", donc " + place + " " + (c.sig ? relAbove(c.ratio) : "est proche du chiffre national") + ".";
    }
    return { main: FR_MARK + main, cmp: FR_MARK + cmp };
  }

  /* Vietnamese: no plural or agreement, so a share reads "Khoảng 1 trong 4 người ở X ..." / "Khoảng một nửa số người ..." / "Gần như tất cả ...".
     The spec's vi piece is { subj, pred }. The leading \u2060 marks text that is already Vietnamese, so the page can format its numbers (1.234,5). */
  function shareVi(p, bare) {
    if (p >= 97) return "gần như tất cả";
    for (var i = 0; i < FRACTIONS.length; i++) {
      if (Math.abs(p - FRACTIONS[i][0] * 100) <= 2) { var f = FR_FRACS[FRACTIONS[i][1]]; return f ? "khoảng " + f[0] + " trong " + f[1] : "khoảng một nửa" + (bare ? "" : " số"); }
    }
    if (p >= 10) return "khoảng " + Math.round(p) + " trong 100";
    if (p >= 0.5) return "khoảng 1 trong " + Math.round(100 / p);
    return "ít hơn 1 trong 200";
  }
  function sentenceVi(c, spec, place) {
    var vi = spec.vi || {}, fill = function (s) { return String(s || "").replace(/\{P\}/g, place); }, main, cmp;
    if (spec.main) main = spec.main(c, place);
    else main = shareVi(c.p).replace(/^./, function (m) { return m.toUpperCase(); }) + " " + fill(vi.subj) + " " + fill(vi.pred) + ".";
    if (spec.cmp) cmp = spec.cmp(c, place);
    else if (c.type === "pct") {
      var clearGap = c.sig && (c.ratio >= 1.15 || c.ratio <= 0.87);
      cmp = "Trên toàn nước Mỹ, con số này là " + shareVi(c.pus, true) + (clearGap ? ", nên ở " + place + " nhóm này " + relCommon(c.ratio) + "." : ", nên " + place + " rất giống Hoa Kỳ ở điểm này.");
    } else {
      cmp = (spec.usWordVi || "Mức cả nước") + " là " + fmt(c, c.pus) + ", nên " + place + " " + (c.sig ? relAbove(c.ratio) : "gần bằng mức cả nước") + ".";
    }
    return { main: FR_MARK + main, cmp: FR_MARK + cmp };
  }
  function sentenceEs(c, spec, place) {
    var es = spec.es || {}, fill = function (s) { return String(s).replace(/\{P\}/g, place); }, main, cmp;
    if (spec.main) main = spec.main(c, place);
    else {
      var sw = shareWordsEs(c.p, es.g);
      main = sw.t + (sw.de ? " de " : " ") + fill(sw.of ? es.subjDef : es.subj) + " " + fill(es.pred) + ".";
    }
    if (spec.cmp) cmp = spec.cmp(c, place);
    else if (c.type === "pct") {
      var us = shareWordsEs(c.pus, es.g).t.toLowerCase();
      var clearGap = c.sig && (c.ratio >= 1.15 || c.ratio <= 0.87);
      cmp = clearGap ? "A nivel nacional, la cifra es " + us + ", lo que la hace " + relCommon(c.ratio) + " en " + place + "."
                  : "A nivel nacional, la cifra es " + us + ", así que " + place + " se parece mucho a EE. UU. en este aspecto.";
    } else {
      cmp = (spec.usWordEs || "La cifra nacional") + " es " + fmt(c, c.pus) + ", así que " + place + " " + (c.sig ? relAbove(c.ratio) : "está cerca de la cifra nacional") + ".";
    }
    return { main: main, cmp: cmp };
  }
  function sentence(c, spec, place) {
    if (api.lang === "es") return sentenceEs(c, spec, place);
    if (api.lang === "fr") return sentenceFr(c, spec, place);
    if (api.lang === "vi") return sentenceVi(c, spec, place);
    var fill = function (s) { return String(s).replace(/\{P\}/g, place); };
    var main, cmp;
    if (spec.main) main = spec.main(c, place);
    else {
      var sw = shareWords(c.p);
      main = sw.t + (sw.of ? " of the " : " ") + fill(spec.subj) + " " + fill(spec.pred) + ".";
    }
    if (spec.cmp) cmp = spec.cmp(c, place);
    else if (c.type === "pct") {
      var us = shareWords(c.pus).t.toLowerCase();
      var clearGap = c.sig && (c.ratio >= 1.15 || c.ratio <= 0.87);   // a real but tiny gap reads as "about the same"
      cmp = clearGap ? "Nationwide it's " + us + ", which makes it " + relCommon(c.ratio) + " in " + place + "."
                  : "Nationwide it's " + us + ", so " + place + " looks a lot like the U.S. here.";
    } else {
      var usTxt = fmt(c, c.pus);
      cmp = (spec.usWord || "The U.S. figure") + " is " + usTxt + ", so " + place + " is " + (c.sig ? relAbove(c.ratio) : "close to the national figure") + ".";
    }
    return { main: main, cmp: cmp };
  }

  /* ---------- "Mix of backgrounds": chance two random residents differ in race/ethnicity ---------- */
  var DIV_GROUPS = [
    ["hispanic or latino and race", "hispanic or latino (of any race)"],
    ["not hispanic or latino", "white alone"],
    ["not hispanic or latino", "black or african american alone"],
    ["not hispanic or latino", "american indian and alaska native alone"],
    ["not hispanic or latino", "asian alone"],
    ["not hispanic or latino", "native hawaiian and other pacific islander alone"],
    ["not hispanic or latino", "some other race alone"],
    ["not hispanic or latino", "two or more races"]
  ];
  function diversityValue(items, row) {
    var shares = [];
    DIV_GROUPS.forEach(function (terms) {
      var it = findItem(items, terms); if (!it) return;
      var p = getVals(row, it.base).p; if (p === null) return;
      shares.push(p);
    });
    if (shares.length < 5) return null;
    var sum = shares.reduce(function (a, b) { return a + b; }, 0);
    if (sum < 90 || sum > 101) return null;                      // groups don't cover the population: don't guess
    var s2 = shares.reduce(function (a, b) { return a + (b / 100) * (b / 100); }, 0);
    return (1 - s2) * 100;
  }
  function diversityCompare(items, pl, us) {
    var a = diversityValue(items, pl), b = diversityValue(items, us);
    if (a === null || b === null) return null;
    return {
      item: { base: "DIVERSITY", topic: "MIX", segs: ["Mix of backgrounds"], last: "Mix of backgrounds", denom: "", search: "" },
      type: "pct", p: a, pus: b, m: null, mus: null, z: 0, rel: Math.abs(Math.log((a + 1) / (b + 1))),
      diff: a - b, cv: 0, sig: false, ratio: a / b
    };
  }

  var api = {
    lang: "en",
    trimNum: trimNum, shareWords: shareWords, relCommon: relCommon, relAbove: relAbove, sentence: sentence,
    diversityCompare: diversityCompare, diversityValue: diversityValue,
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
