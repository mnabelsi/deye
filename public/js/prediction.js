import { esc, icon } from './util.js';

// The grid prediction widget (Overview and Events) and the list of day cases behind it (Events).
// Both draw what /api/event-log/forecast returns; see src/schedule.js for how it is worked out.

const pad = (n) => String(n).padStart(2, '0');
const hm = (minute) => `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;
const span = ([a, b]) => `${hm(a)}–${hm(b)}`;
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const pct = (p) => `${Math.round(p * 100)}%`;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dur(seconds) {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const h = Math.round(m / 60);
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}
const dateOf = (day, opts) => new Date(day * 86400000).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
const caseName = (c) => (c.irregular ? 'an irregular day' : `Case ${c.id}`);
const chip = (c, extra = '') => `<span class="case-chip case-${c.irregular ? 'x' : c.id.toLowerCase()}" ${extra}>${c.irregular ? '?' : esc(c.id)}</span>`;
const onText = (c) => (c.on.length ? `on ${list(c.on.map(span))}` : 'off all day');

function strip(values, { seen = [], now = -1, tip }) {
  return `<div class="fc-strip">${values
    .map((p, s) => {
      const v = p === null || p === undefined ? null : Math.round(p * 100);
      return `<span class="fc-cell ${seen[s] ? 'seen' : ''} ${s === now ? 'now' : ''}" style="--p:${v === null ? 0 : v}%" title="${esc(`${hm(s * 30)}–${hm((s + 1) * 30)} · ${v === null ? 'unknown' : tip(v, s)}`)}"></span>`;
    })
    .join('')}</div>`;
}
const AXIS = `<div class="fc-strip fc-axis">${Array.from({ length: 24 }, (_, h) => `<span>${h % 3 ? '' : pad(h)}</span>`).join('')}</div>`;

/** How the order of the cases was worked out, in words. */
function orderText(o) {
  if (o.kind === 'cycle') return o.every === 1 ? 'the same case comes every day' : o.every === 2 ? 'the cases alternate from one day to the next' : o.every === 7 ? 'the cases go by the day of the week' : `the cases come round every ${o.every} days`;
  if (o.kind === 'follows') return o.depth === 2 ? 'the case follows from the two days before it' : 'each case is usually followed by the same one';
  return 'the cases come in no fixed order, so the commonest ones are assumed';
}

/**
 * The prediction widget. `data` is the answer of /api/event-log/forecast; `link` adds a link to
 * the Events page (for the Overview).
 */
export function predictionCard(data, { link = false } = {}) {
  const src = data && data.source;
  if (!src) return '';
  const sc = src.schedule;
  const head = `<div class="card-head"><h2>${icon('grid', 'style="width:16px;height:16px;vertical-align:-3px"')} ${esc(src.name)} prediction</h2>${link ? '<a class="small" href="#/events">Cases and patterns →</a>' : ''}</div>`;
  if (!sc) return `<div class="card">${head}<p class="muted" style="margin:0">Not enough history to predict yet. It needs a few full days of readings; importing history in Settings gives it more to learn from.</p></div>`;

  const timeIn = (ts) => {
    try {
      return new Date(ts * 1000).toLocaleTimeString(undefined, { timeZone: data.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    }
  };
  // The nearest hours depend more on how long it has been on or off than on the schedule.
  let now = '';
  if (src.now) {
    const state = src.now.on ? 'on' : 'off';
    const usual = src.now.on ? src.onStretch : src.offStretch;
    const forText = `${src.now.exact ? 'for' : 'for at least'} ${dur(Date.now() / 1000 - src.now.since)}`;
    const at = usual && usual.n >= 3 && src.now.exact ? src.now.since + usual.median : null;
    now = `<p style="margin:0 0 12px"><span class="badge ${src.now.on ? 'ok' : ''}">${src.now.on ? 'On' : 'Off'} now</span> ${forText}${
      at === null ? '' : `. It usually stays ${state} about ${dur(usual.median)}, ${at > Date.now() / 1000 ? `so expect it to ${src.now.on ? 'go off' : 'come back'} around <b>${esc(timeIn(at))}</b>` : `so it could ${src.now.on ? 'go off' : 'come back'} at any moment`}`
    }.</p>`;
  }

  const byId = new Map(sc.cases.map((c) => [c.id, c]));
  const row = (d, isToday) => {
    const what = d.likely.length
      ? `Likely on ${list(d.likely.map(span))}${d.possible.length ? `; possibly ${list(d.possible.map(span))}` : ''}.`
      : d.possible.length
        ? `No time looks likely; possibly ${list(d.possible.map(span))}.`
        : `Unlikely to be on${isToday ? ' for the rest of the day' : ''}.`;
    const options = d.cases
      .slice(0, 4)
      .map((x) => {
        const c = byId.get(x.id);
        return `<li>${chip(c)}<b>${pct(x.p)}</b> <span>${c.irregular ? 'an irregular day, like no case seen before' : esc(onText(c))}</span></li>`;
      })
      .join('');
    return `<div class="fc-row"><div class="fc-label"><b>${isToday ? 'Today' : 'Tomorrow'}</b><span class="small faint">${esc(dateOf(d.day, { weekday: 'short', month: 'short', day: 'numeric' }))}</span></div>
      <div>${strip(d.chance, { seen: d.seen, now: isToday ? sc.slotNow : -1, tip: (v, s) => (d.seen[s] ? `was on ${v}% of it` : `${v}% chance of being on`) })}
        <div style="margin-top:6px"><b>${esc(isToday ? what.replace(/^Likely on/, 'Still to come: likely on') : what)}</b></div>
        <ul class="case-options">${options}</ul></div></div>`;
  };

  const acc = Math.round(sc.slots.accuracy * 100);
  const base = sc.slots.baseline === null ? null : Math.round(sc.slots.baseline * 100);
  const weak = base !== null && acc - base < 5;
  const order = sc.order.checked ? `In the last weeks ${orderText(sc.order)}; that named the right case on ${sc.order.right} of the last ${sc.order.checked} days. ` : '';
  return `<div class="card">${head}${now}
    <div class="fc"><div class="fc-row"><div></div>${AXIS}</div>${row(sc.today, true)}${row(sc.tomorrow, false)}</div>
    <p class="small ${weak ? '' : 'faint'}" style="margin:12px 0 0">${weak ? `${icon('warn', 'style="width:14px;height:14px;vertical-align:-2px"')} <b>Treat this as a rough guess:</b> ${esc(src.name)} has not kept to a schedule lately. ` : ''}
      A stronger colour means a higher chance; the part of today that is over shows what happened. The percentages are how likely each kind of day is. ${esc(order)}
      Half-hour by half-hour it was right ${acc}% of the time over the last two weeks${base === null ? '' : ` (always guessing whichever of on and off is commoner would score ${base}%)`}.</p></div>`;
}

/** Every day schedule found in the history, and the order they came in. */
export function casesCard(data) {
  const src = data && data.source;
  const sc = src && src.schedule;
  if (!sc) return '';
  const byId = new Map(sc.cases.map((c) => [c.id, c]));
  const rows = sc.cases
    .map((c) => {
      const facts = [`${c.days} day${c.days === 1 ? '' : 's'} (${pct(c.share)})`, `about ${Math.round(c.hoursOn * 10) / 10} h on`];
      const top = c.weekdays.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0]);
      if (!c.irregular && c.days >= 4 && (top[0][0] + top[1][0]) / c.days >= 0.75) facts.push(`mostly ${top[1][0] ? `${WEEKDAYS[Math.min(top[0][1], top[1][1])]} and ${WEEKDAYS[Math.max(top[0][1], top[1][1])]}` : WEEKDAYS[top[0][1]]}`);
      facts.push(`last on ${dateOf(c.lastDay, { month: 'short', day: 'numeric' })}`);
      const next = c.next && !c.irregular ? `The day after is usually ${esc(caseName(byId.get(c.next.id)))} (${c.next.times} of ${c.next.of} times).` : '';
      return `<div class="fc-row"><div class="fc-label">${chip(c)}<b>${c.irregular ? 'Irregular days' : `Case ${esc(c.id)}`}</b></div>
        <div>${strip(c.profile, { tip: (v) => `on ${v}% of these days` })}
          <div style="margin-top:6px">${c.irregular ? 'Days that matched none of the cases; the bar shows their average.' : `<b>${esc(onText(c).replace(/^on/, 'On'))}</b>`} <span class="small muted">· ${esc(facts.join(' · '))}</span></div>
          ${next ? `<div class="small muted">${next}</div>` : ''}</div></div>`;
    })
    .join('');
  const cal = sc.calendar
    .map((d) => {
      const c = d.id && byId.get(d.id);
      const title = `title="${esc(`${dateOf(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}${c ? ` · ${c.irregular ? 'irregular day' : `Case ${c.id}`}` : ' · not enough readings'}`)}"`;
      return `<span class="cal-day">${c ? chip(c, title) : `<span class="case-chip none" ${title}>·</span>`}<span>${esc(dateOf(d.day, { day: 'numeric' }))}</span></span>`;
    })
    .join('');
  const regular = sc.cases.filter((c) => !c.irregular).length;
  return `<div class="card"><div class="card-head"><h2>${esc(src.name)}'s day schedules</h2></div>
    <p style="margin:0 0 12px">Over the last ${sc.daysUsed} full days ${esc(src.name)} followed <b>${regular} different day schedule${regular === 1 ? '' : 's'}</b>. Each bar is a day from midnight to midnight; a stronger colour means it was on at that time on more of those days.</p>
    <div class="fc"><div class="fc-row"><div></div>${AXIS}</div>${rows}</div>
    <h3 class="cal-title">Which case each day was</h3>
    <div class="cal">${cal}</div>
    <p class="small faint" style="margin:10px 0 0">In the last weeks ${esc(orderText(sc.order))}. Days are grouped when they differ in less than about 4 hours; days are counted in ${esc(data.timeZone)} time.</p></div>`;
}
