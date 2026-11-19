'use strict';

// Works out the schedule an outside source (the grid) follows and predicts today and tomorrow.
//
// A rationed grid rarely keeps the same hours every day; it alternates between a few day
// schedules ("one day on at 14:00, the next at 22:00"). So instead of averaging hours:
// 1. Each past day becomes 48 half-hours, on or off.
// 2. Days that look alike are grouped into cases (A, B, C…); the rest are irregular days.
// 3. The order the cases come in is learned: a fixed rotation (every 2, 3… days, by weekday), or
//    which case follows which. Each way of guessing is scored on the past and the best one is used.
// 4. Today's case is narrowed down from what already happened today; tomorrow's follows from it.
// A plain "same half-hour N days ago" forecast is scored alongside, and used when it does better.
//
// Pure functions, so they can be checked in Node with made-up schedules.

const SLOTS = 48; // half-hours in a day
const HISTORY_DAYS = 56;
const MIN_KNOWN = 40; // half-hours a day needs readings for to be used
const ALIKE = 0.16; // days differing in less than this share of half-hours are the same case
const MAX_CASES = 6;
const DAY_TEST = 28; // recent days the order of cases is scored on
const SLOT_TEST = 14; // recent days the half-hour forecasts are scored on
const LIKELY = 0.6;
const POSSIBLE = 0.4;
const OTHER = '?';
const CYCLES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14];
const REPEATS = [
  { every: 1, back: 28, decay: 0.93 },
  ...CYCLES.map((every) => ({ every, back: every > 7 ? 3 : 4, decay: 0.6 })),
];

/** [[fromMinute, toMinute]] where `test(value)` holds, from 48 half-hour values. */
function ranges(values, test, skip = () => false) {
  const out = [];
  for (let s = 0; s < SLOTS; s++) {
    if (skip(s) || values[s] === null || !test(values[s])) continue;
    if (out.length && out[out.length - 1][1] === s * 30) out[out.length - 1][1] = (s + 1) * 30;
    else out.push([s * 30, (s + 1) * 30]);
  }
  return out;
}

// ---------- 1 & 2: days and cases ----------

function readDays(slots, today) {
  const days = [];
  for (let day = today - HISTORY_DAYS; day < today; day++) {
    const bits = new Uint8Array(SLOTS);
    const known = new Uint8Array(SLOTS);
    let n = 0;
    for (let s = 0; s < SLOTS; s++) {
      const v = slots.get(day * SLOTS + s);
      if (v === undefined) continue;
      bits[s] = v >= 0.5 ? 1 : 0;
      known[s] = 1;
      n += 1;
    }
    if (n < MIN_KNOWN) continue;
    // Short holes take the state next to them.
    for (let s = 0; s < SLOTS; s++) {
      if (known[s]) continue;
      let k = s;
      while (k >= 0 && !known[k]) k -= 1;
      if (k < 0) for (k = s; k < SLOTS && !known[k]; ) k += 1;
      bits[s] = bits[k];
    }
    days.push({ day, bits });
  }
  return days;
}

const differ = (a, b) => {
  let n = 0;
  for (let s = 0; s < SLOTS; s++) if (a[s] !== b[s]) n += 1;
  return n / SLOTS;
};

/** Groups alike days (average linkage). Returns groups of indexes into `days`, biggest first. */
function group(days) {
  const d = days.map((a) => days.map((b) => differ(a.bits, b.bits)));
  let groups = days.map((_, i) => [i]);
  for (;;) {
    let best = null;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        let sum = 0;
        for (const a of groups[i]) for (const b of groups[j]) sum += d[a][b];
        const avg = sum / (groups[i].length * groups[j].length);
        if (avg <= ALIKE && (!best || avg < best.avg)) best = { i, j, avg };
      }
    }
    if (!best) break;
    groups[best.i] = groups[best.i].concat(groups[best.j]);
    groups = groups.filter((_, k) => k !== best.j);
  }
  return groups.sort((a, b) => b.length - a.length || Math.max(...b) - Math.max(...a));
}

// ---------- 3: the order of cases ----------

const normalise = (m) => {
  let sum = 0;
  for (const v of m.values()) sum += v;
  if (!sum) return null;
  for (const [k, v] of m) m.set(k, v / sum);
  return m;
};

/**
 * Ways of guessing the case of day `t` from the cases of earlier days (`labels[i]`, null when
 * the day is unknown). Each returns Map(case → chance) or null when it has nothing to go on.
 */
function guessers(ids) {
  const freq = (labels, t) => {
    const m = new Map(ids.map((id) => [id, 0.01]));
    for (let i = 0; i < t; i++) if (labels[i]) m.set(labels[i], m.get(labels[i]) + 1);
    return normalise(m);
  };
  const out = [{ kind: 'usual', guess: freq }];
  for (const every of CYCLES) {
    out.push({
      kind: 'cycle',
      every,
      guess(labels, t) {
        const m = new Map();
        let w = 1;
        for (let k = 1; k <= 4; k++, w *= 0.6) {
          const l = labels[t - k * every];
          if (l) m.set(l, (m.get(l) || 0) + w);
        }
        return normalise(m);
      },
    });
  }
  for (const depth of [1, 2]) {
    out.push({
      kind: 'follows',
      depth,
      guess(labels, t) {
        for (let k = 1; k <= depth; k++) if (!labels[t - k]) return null;
        const m = new Map();
        let seen = 0;
        for (let i = depth; i < t; i++) {
          if (!labels[i]) continue;
          let same = true;
          for (let k = 1; k <= depth; k++) if (labels[i - k] !== labels[t - k]) same = false;
          if (!same) continue;
          m.set(labels[i], (m.get(labels[i]) || 0) + 1);
          seen += 1;
        }
        return seen >= depth ? normalise(m) : null;
      },
    });
  }
  // Every guess keeps a little of "how common each case is", so nothing is ever ruled out.
  const soften = (g) => (labels, t) => {
    const base = freq(labels, t);
    const m = g(labels, t);
    if (!m) return base;
    const res = new Map();
    for (const id of ids) res.set(id, 0.9 * (m.get(id) || 0) + 0.1 * (base.get(id) || 0));
    return res;
  };
  return out.map((g) => ({ ...g, guess: g.kind === 'usual' ? g.guess : soften(g.guess) }));
}

const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];

// ---------- the analysis ----------

/**
 * `slots`: Map(day × 48 + half-hour → share of it the source was on), days counted in local time.
 * `today`, `slotNow`: the local day and half-hour it is now.
 * Returns null when there is too little history.
 */
function analyse(slots, today, slotNow) {
  const days = readDays(slots, today);
  if (days.length < 4) return null;
  const groups = group(days);
  const real = groups.filter((g) => g.length >= 2).slice(0, MAX_CASES);
  const rest = groups.filter((g) => !real.includes(g)).flat();
  const cases = real.map((g, i) => ({ id: String.fromCharCode(65 + i), members: g }));
  if (rest.length) cases.push({ id: OTHER, members: rest });
  const ids = cases.map((c) => c.id);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const labelOf = new Map();
  for (const c of cases) {
    c.sum = new Float64Array(SLOTS);
    for (const i of c.members) {
      labelOf.set(days[i].day, c.id);
      for (let s = 0; s < SLOTS; s++) c.sum[s] += days[i].bits[s];
    }
    c.profile = Array.from(c.sum, (v) => v / c.members.length);
  }
  const bitsOf = new Map(days.map((d) => [d.day, d.bits]));
  const first = today - HISTORY_DAYS;
  const labels = [];
  for (let day = first; day < today; day++) labels.push(labelOf.get(day) || null);
  const T = labels.length; // index of today

  // Score each way of guessing the day's case on the recent past.
  const scored = guessers(ids).map((g) => {
    let prob = 0;
    let right = 0;
    let n = 0;
    for (let t = Math.max(5, T - DAY_TEST); t < T; t++) {
      if (!labels[t]) continue;
      const m = g.guess(labels, t);
      prob += m.get(labels[t]) || 0;
      right += top(m) === labels[t] ? 1 : 0;
      n += 1;
    }
    return { ...g, n, prob: n ? prob / n : 0, right };
  });
  const usual = scored[0];
  // A more elaborate rule has to beat "the commonest case" clearly to be believed.
  let order = usual;
  for (const g of scored) if (g.n >= 5 && g.prob > order.prob + (order === usual ? 0.08 : 1e-9)) order = g;

  // Half-hour forecasts: from the cases, and from plain repetition.
  const mix = (dist, leaveOut) => {
    const out = new Array(SLOTS).fill(0);
    for (const [id, p] of dist) {
      const c = byId.get(id);
      const drop = leaveOut !== undefined && labelOf.get(leaveOut) === id && c.members.length > 1 ? bitsOf.get(leaveOut) : null;
      for (let s = 0; s < SLOTS; s++) out[s] += p * (drop ? (c.sum[s] - drop[s]) / (c.members.length - 1) : c.profile[s]);
    }
    return out;
  };
  const repeat = (r, day, s) => {
    let sum = 0;
    let weight = 0;
    let w = 1;
    for (let k = 1; k <= r.back; k++, w *= r.decay) {
      const v = slots.get((day - k * r.every) * SLOTS + s);
      if (v === undefined) continue;
      sum += v * w;
      weight += w;
    }
    return weight ? sum / weight : null;
  };
  const score = (predict) => {
    let right = 0;
    let n = 0;
    let on = 0;
    for (let day = today - SLOT_TEST; day < today; day++) {
      const bits = bitsOf.get(day);
      if (!bits) continue;
      const p = predict(day);
      if (!p) continue;
      for (let s = 0; s < SLOTS; s++) {
        if (p[s] === null) continue;
        right += p[s] >= 0.5 === (bits[s] === 1) ? 1 : 0;
        on += bits[s];
        n += 1;
      }
    }
    return { right, n, on, accuracy: n ? right / n : 0 };
  };
  const byCases = score((day) => (day - first >= 5 ? mix(order.guess(labels, day - first), day) : null));
  let bestRepeat = null;
  for (const r of REPEATS) {
    const sc = score((day) => Array.from({ length: SLOTS }, (_, s) => repeat(r, day, s)));
    if (sc.n >= 96 && (!bestRepeat || sc.accuracy > bestRepeat.accuracy)) bestRepeat = { ...sc, repeat: r };
  }
  const useRepeat = Boolean(bestRepeat) && (byCases.n < 96 || bestRepeat.accuracy > byCases.accuracy + 0.03);
  const used = useRepeat ? bestRepeat : byCases;

  // Today: start from the guess for today, then keep the cases that fit what happened so far.
  const prior = order.guess(labels, T);
  const post = new Map();
  let seenSlots = 0;
  for (const id of ids) {
    let like = 1;
    const c = byId.get(id);
    for (let s = 0; s < slotNow; s++) {
      const v = slots.get(today * SLOTS + s);
      if (v === undefined) continue;
      const p = Math.min(0.92, Math.max(0.08, c.profile[s]));
      like *= v >= 0.5 ? p : 1 - p;
    }
    post.set(id, (prior.get(id) || 0) * like);
  }
  for (let s = 0; s < slotNow; s++) if (slots.get(today * SLOTS + s) !== undefined) seenSlots += 1;
  normalise(post) || ids.forEach((id) => post.set(id, 1 / ids.length));

  // Tomorrow: for each case today might be, what follows it.
  const next = new Map(ids.map((id) => [id, 0]));
  for (const [id, p] of post) {
    const m = order.guess([...labels, id], T + 1);
    for (const [k, v] of m) next.set(k, next.get(k) + p * v);
  }

  const outlook = (day, dist, isToday) => {
    const seen = [];
    const chance = [];
    const fromCases = mix(dist);
    for (let s = 0; s < SLOTS; s++) {
      const actual = isToday && s < slotNow ? slots.get(day * SLOTS + s) : undefined;
      seen.push(actual !== undefined);
      chance.push(actual !== undefined ? actual : useRepeat ? repeat(bestRepeat.repeat, day, s) : fromCases[s]);
    }
    const skip = (s) => seen[s] || (isToday && s < slotNow);
    return {
      day,
      chance,
      seen,
      likely: ranges(chance, (p) => p >= LIKELY, skip),
      possible: ranges(chance, (p) => p >= POSSIBLE && p < LIKELY, skip),
      cases: [...dist.entries()].map(([id, p]) => ({ id, p })).filter((x) => x.p >= 0.05).sort((a, b) => b.p - a.p),
    };
  };

  // What follows each case, for the "after an A day comes B" lines.
  const follows = new Map(ids.map((id) => [id, new Map()]));
  for (let t = 1; t < T; t++) {
    if (!labels[t] || !labels[t - 1]) continue;
    const m = follows.get(labels[t - 1]);
    m.set(labels[t], (m.get(labels[t]) || 0) + 1);
  }

  return {
    slotNow,
    daysUsed: days.length,
    cases: cases.map((c) => {
      const f = [...follows.get(c.id).entries()].sort((a, b) => b[1] - a[1]);
      const weekdays = new Array(7).fill(0); // Monday first
      for (const i of c.members) weekdays[(((days[i].day + 3) % 7) + 7) % 7] += 1;
      return {
        id: c.id,
        irregular: c.id === OTHER,
        days: c.members.length,
        share: c.members.length / days.length,
        profile: c.profile.map((v) => Math.round(v * 100) / 100),
        on: ranges(c.profile, (p) => p >= 0.5),
        hoursOn: c.profile.reduce((a, b) => a + b, 0) / 2,
        lastDay: Math.max(...c.members.map((i) => days[i].day)),
        weekdays,
        next: f.length ? { id: f[0][0], times: f[0][1], of: f.reduce((a, b) => a + b[1], 0) } : null,
      };
    }),
    calendar: Array.from({ length: Math.min(28, T) }, (_, k) => ({ day: today - Math.min(28, T) + k, id: labels[T - Math.min(28, T) + k] })),
    order: { kind: order.kind, every: order.every || null, depth: order.depth || null, right: order.right, checked: order.n, usualRight: usual.right },
    slots: { by: useRepeat ? 'repeat' : 'cases', every: useRepeat ? bestRepeat.repeat.every : null, accuracy: used.accuracy, checked: used.n, baseline: used.n ? Math.max(used.on, used.n - used.on) / used.n : null },
    todaySeen: seenSlots,
    today: outlook(today, post, true),
    tomorrow: outlook(today + 1, next, false),
  };
}

module.exports = { analyse, SLOTS, HISTORY_DAYS };
