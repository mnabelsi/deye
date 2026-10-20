// ECharts helpers. Series with different units are never put on two y-axes of the same
// plot; they get stacked panels that share one time axis, one crosshair and one zoom.
import { cssVar, esc, fmtNumber } from './util.js';

const instances = new Set();

export function themeTokens() {
  return {
    text: cssVar('--text'),
    text2: cssVar('--text-2'),
    text3: cssVar('--text-3'),
    surface: cssVar('--surface'),
    border: cssVar('--border'),
    grid: cssVar('--chart-grid'),
    axis: cssVar('--chart-axis'),
    primary: cssVar('--primary'),
    primarySoft: cssVar('--primary-soft'),
  };
}

export function refreshAllCharts() {
  for (const c of instances) c.rerender();
}

function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${fmtNumber(v / 1e6, 1)}M`;
  if (a >= 1e3) return `${fmtNumber(v / 1e3, 1)}K`;
  return fmtNumber(v, a < 10 ? 2 : 1);
}

// Break lines where data is missing instead of drawing a straight line across the gap.
export function withGaps(points, minGapMs) {
  if (points.length < 3) return points;
  let typical = Infinity;
  for (let i = 1; i < Math.min(points.length, 50); i++) typical = Math.min(typical, points[i][0] - points[i - 1][0]);
  const limit = Math.max(minGapMs || 0, (Number.isFinite(typical) ? typical : 0) * 4, 20 * 60 * 1000);
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] - points[i - 1][0] > limit) out.push([points[i - 1][0] + 1, null]);
    out.push(points[i]);
  }
  return out;
}

function timeLabel(ms, spanMs) {
  const d = new Date(ms);
  if (spanMs > 3 * 86400000) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * panels: [{ title, unit, series: [{ id, name, color, data: [[ms, v]], unit }] }]
 * opts:   { type: 'line'|'area'|'step'|'bar', panelHeight, onZoom(startMs, endMs), group }
 */
export function createTimeChart(el, opts = {}) {
  const chart = echarts.init(el, null, { renderer: 'canvas' });
  let panels = [];
  let hidden = new Set();
  let zoom = null;
  const state = { opts };

  const ro = new ResizeObserver(() => chart.resize());
  ro.observe(el);

  function build() {
    const t = themeTokens();
    const n = Math.max(panels.length, 1);
    const type = state.opts.type || 'line';
    const topPad = 34;
    const sliderH = state.opts.noSlider ? 0 : 54;
    const height = el.clientHeight || 380;
    const usable = height - sliderH - 8;
    const ph = usable / n;
    // On narrow screens end labels would squeeze the plot; the legend pills identify series instead.
    const wide = (el.clientWidth || 800) >= 640;
    const allX = panels.map((_, i) => i);
    let spanMs = 0;
    for (const p of panels) for (const s of p.series) if (s.data.length) spanMs = Math.max(spanMs, s.data[s.data.length - 1][0] - s.data[0][0]);

    const grids = [];
    const xAxes = [];
    const yAxes = [];
    const titles = [];
    const series = [];
    const legendNames = [];

    panels.forEach((p, i) => {
      const top = i * ph + topPad;
      grids.push({ left: 58, right: 28, top, height: Math.max(ph - topPad - 26, 60), containLabel: false });
      titles.push({
        text: p.title,
        left: 58,
        top: i * ph + 6,
        textStyle: { fontSize: 12, fontWeight: 600, color: t.text2 },
      });
      xAxes.push({
        type: 'time',
        gridIndex: i,
        axisLine: { lineStyle: { color: t.axis } },
        axisTick: { show: false },
        axisLabel: { color: t.text3, hideOverlap: true, formatter: (v) => timeLabel(v, spanMs) },
        splitLine: { show: false },
      });
      const isPercent = p.unit === '%';
      yAxes.push({
        type: 'value',
        gridIndex: i,
        scale: !['W', 'kW', 'kWh', 'Wh', 'A'].includes(p.unit),
        max: isPercent ? 100 : undefined,
        min: isPercent ? 0 : undefined,
        splitNumber: ph < 200 ? 3 : 5,
        axisLabel: { color: t.text3, formatter: compact },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: t.grid, width: 1, type: 'solid' } },
      });
      const labelEnds = p.series.length <= 4 && type !== 'bar' && !state.opts.noEndLabels && wide;
      p.series.forEach((s) => {
        legendNames.push(s.name);
        const base = {
          id: String(s.id),
          name: s.name,
          xAxisIndex: i,
          yAxisIndex: i,
          data: type === 'bar' ? s.data : withGaps(s.data),
          color: s.color,
          emphasis: { focus: 'series' },
          animationDuration: 300,
        };
        if (type === 'bar') {
          series.push({ ...base, type: 'bar', barMaxWidth: 24, barGap: '15%', itemStyle: { borderRadius: [4, 4, 0, 0] } });
        } else {
          series.push({
            ...base,
            type: 'line',
            step: type === 'step' ? 'end' : false,
            showSymbol: false,
            symbol: 'circle',
            symbolSize: 8,
            sampling: 'lttb',
            connectNulls: false,
            lineStyle: { width: 2, cap: 'round', join: 'round' },
            itemStyle: { borderColor: t.surface, borderWidth: 2 },
            areaStyle: type === 'area' ? { opacity: 0.1 } : undefined,
            endLabel: labelEnds
              ? { show: true, formatter: () => s.name, color: t.text2, fontSize: 11, distance: 6, width: 92, overflow: 'truncate' }
              : undefined,
            labelLayout: labelEnds ? { hideOverlap: true } : undefined,
          });
        }
      });
    });

    if (labelEndsAny()) grids.forEach((g) => (g.right = 110));

    const selected = {};
    for (const name of legendNames) selected[name] = !hidden.has(name);

    const option = {
      backgroundColor: 'transparent',
      animation: true,
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
      title: titles,
      grid: grids.length ? grids : [{ left: 58, right: 28, top: 30, bottom: 60 }],
      xAxis: xAxes.length ? xAxes : [{ type: 'time' }],
      yAxis: yAxes.length ? yAxes : [{ type: 'value' }],
      legend: { show: false, data: legendNames, selected },
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: t.axis, width: 1 }, label: { backgroundColor: t.text2 } },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        padding: [8, 10],
        textStyle: { color: t.text, fontSize: 12 },
        extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,.18); border-radius: 10px;',
        axisPointer: { type: 'line' },
        formatter: (items) => tooltipHtml(items, t),
      },
      toolbox: {
        right: 8,
        top: 0,
        itemSize: 14,
        iconStyle: { borderColor: t.text3 },
        emphasis: { iconStyle: { borderColor: t.primary } },
        feature: {
          dataZoom: { yAxisIndex: 'none', title: { zoom: 'Box zoom', back: 'Undo zoom' } },
          restore: { title: 'Reset' },
          saveAsImage: { title: 'Save PNG', backgroundColor: t.surface, pixelRatio: 2 },
        },
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: allX, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true },
        ...(state.opts.noSlider
          ? []
          : [
              {
                type: 'slider',
                xAxisIndex: allX,
                filterMode: 'none',
                bottom: 10,
                height: 26,
                borderColor: t.border,
                backgroundColor: 'transparent',
                fillerColor: t.primarySoft,
                handleStyle: { color: t.surface, borderColor: t.primary },
                moveHandleStyle: { color: t.primary, opacity: 0.4 },
                dataBackground: { lineStyle: { color: t.axis }, areaStyle: { color: t.grid } },
                selectedDataBackground: { lineStyle: { color: t.primary }, areaStyle: { color: t.primarySoft } },
                textStyle: { color: t.text3 },
                labelFormatter: (v) => (v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''),
              },
            ]),
      ],
      series,
    };
    if (zoom) {
      option.dataZoom.forEach((dz) => {
        dz.start = zoom.start;
        dz.end = zoom.end;
      });
    }
    return option;

    function labelEndsAny() {
      return type !== 'bar' && !state.opts.noEndLabels && wide && panels.some((p) => p.series.length <= 4 && p.series.length > 0);
    }
  }

  function tooltipHtml(items, t) {
    if (!items || !items.length) return '';
    const ts = items[0].axisValue;
    const head = `<div style="font-weight:600;color:${t.text2};margin-bottom:6px">${esc(new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</div>`;
    const unitById = new Map();
    for (const p of panels) for (const s of p.series) unitById.set(String(s.id), s.unit || p.unit || '');
    const rows = items
      .filter((it) => it.value && it.value[1] !== null && it.value[1] !== undefined)
      .map((it) => {
        const unit = unitById.get(it.seriesId) || '';
        return `<div style="display:flex;align-items:center;gap:8px;line-height:1.7">
          <span style="width:12px;height:2px;border-radius:1px;background:${it.color};display:inline-block"></span>
          <b style="color:${t.text};font-variant-numeric:tabular-nums">${esc(fmtNumber(it.value[1]))}${unit ? ` ${esc(unit)}` : ''}</b>
          <span style="color:${t.text2}">${esc(it.seriesName)}</span></div>`;
      })
      .join('');
    return head + (rows || `<div style="color:${t.text3}">No data</div>`);
  }

  chart.on('datazoom', () => {
    const o = chart.getOption();
    const dz = o.dataZoom && o.dataZoom[0];
    if (!dz) return;
    zoom = { start: dz.start, end: dz.end };
    if (state.opts.onZoom) state.opts.onZoom(dz.startValue, dz.endValue, zoom);
  });
  chart.on('restore', () => {
    zoom = null;
  });

  const api = {
    chart,
    setData(newPanels, { keepZoom = false } = {}) {
      panels = newPanels;
      if (!keepZoom) zoom = null;
      chart.setOption(build(), { notMerge: true });
    },
    setType(type) {
      state.opts.type = type;
      chart.setOption(build(), { notMerge: true });
    },
    setHidden(names) {
      hidden = new Set(names);
      const selected = {};
      for (const p of panels) for (const s of p.series) selected[s.name] = !hidden.has(s.name);
      chart.setOption({ legend: { selected } });
    },
    resetZoom() {
      zoom = null;
      chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    },
    loading(on) {
      el.style.opacity = on ? '0.55' : '';
    },
    rerender() {
      chart.setOption(build(), { notMerge: true });
    },
    dispose() {
      ro.disconnect();
      instances.delete(api);
      chart.dispose();
    },
  };
  instances.add(api);
  return api;
}

export function createBarChart(el, opts = {}) {
  const chart = echarts.init(el, null, { renderer: 'canvas' });
  const ro = new ResizeObserver(() => chart.resize());
  ro.observe(el);
  let last = null;
  let hidden = new Set();

  function build({ categories, series, unit }) {
    const t = themeTokens();
    const selected = {};
    for (const s of series) selected[s.name] = !hidden.has(s.name);
    return {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
      grid: { left: 58, right: 20, top: 36, bottom: categories.length > 14 ? 70 : 40 },
      legend: { show: false, data: series.map((s) => s.name), selected },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: t.primarySoft } },
        confine: true,
        backgroundColor: t.surface,
        borderColor: t.border,
        textStyle: { color: t.text, fontSize: 12 },
        extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,.18); border-radius: 10px;',
        formatter: (items) => {
          const head = `<div style="font-weight:600;color:${t.text2};margin-bottom:6px">${esc(items[0].axisValue)}</div>`;
          return (
            head +
            items
              .map(
                (it) => `<div style="display:flex;align-items:center;gap:8px;line-height:1.7">
                <span style="width:10px;height:10px;border-radius:3px;background:${it.color};display:inline-block"></span>
                <b style="font-variant-numeric:tabular-nums">${esc(it.value === null || it.value === undefined ? '—' : fmtNumber(it.value, 1))} ${esc(unit)}</b>
                <span style="color:${t.text2}">${esc(it.seriesName)}</span></div>`
              )
              .join('')
          );
        },
      },
      toolbox: {
        right: 4,
        top: -4,
        itemSize: 14,
        iconStyle: { borderColor: t.text3 },
        feature: { saveAsImage: { title: 'Save PNG', backgroundColor: t.surface, pixelRatio: 2 } },
      },
      dataZoom: categories.length > 14
        ? [
            { type: 'inside' },
            { type: 'slider', height: 22, bottom: 8, borderColor: t.border, fillerColor: t.primarySoft, textStyle: { color: t.text3 }, handleStyle: { color: t.surface, borderColor: t.primary } },
          ]
        : [{ type: 'inside' }],
      xAxis: {
        type: 'category',
        data: categories,
        axisLine: { lineStyle: { color: t.axis } },
        axisTick: { show: false },
        axisLabel: { color: t.text3, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        name: unit,
        nameTextStyle: { color: t.text3 },
        axisLabel: { color: t.text3, formatter: compact },
        splitLine: { lineStyle: { color: t.grid } },
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'bar',
        data: s.data,
        color: s.color,
        barMaxWidth: 24,
        barGap: '12%',
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        emphasis: { focus: 'series' },
      })),
    };
  }

  const api = {
    chart,
    setData(data) {
      last = data;
      chart.setOption(build(data), { notMerge: true });
    },
    setHidden(names) {
      hidden = new Set(names);
      if (last) chart.setOption(build(last), { notMerge: true });
    },
    loading(on) {
      el.style.opacity = on ? '0.55' : '';
    },
    rerender() {
      if (last) chart.setOption(build(last), { notMerge: true });
    },
    dispose() {
      ro.disconnect();
      instances.delete(api);
      chart.dispose();
    },
  };
  instances.add(api);
  return api;
}

// Table twin for any time chart: one row per timestamp, one column per series.
export function renderSeriesTable(container, panels, maxRows = 3000) {
  const cols = [];
  for (const p of panels) for (const s of p.series) cols.push(s);
  const times = new Set();
  const maps = cols.map((s) => {
    const m = new Map();
    for (const [t, v] of s.data) {
      if (v === null) continue;
      m.set(t, v);
      times.add(t);
    }
    return m;
  });
  const sorted = [...times].sort((a, b) => b - a);
  const shown = sorted.slice(0, maxRows);
  container.innerHTML = `
    <div class="table-wrap tall">
      <table class="table">
        <thead><tr><th>Time</th>${cols.map((c) => `<th class="num">${esc(c.name)}${c.unit ? ` <span class="faint">(${esc(c.unit)})</span>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${shown
          .map(
            (t) => `<tr><td class="nowrap">${esc(new Date(t).toLocaleString())}</td>${maps
              .map((m) => `<td class="num">${m.has(t) ? esc(fmtNumber(m.get(t))) : '<span class="faint">—</span>'}</td>`)
              .join('')}</tr>`
          )
          .join('')}</tbody>
      </table>
    </div>
    ${sorted.length > maxRows ? `<p class="small faint" style="margin-top:8px">Showing the latest ${maxRows} of ${sorted.length} rows. Use CSV export for everything.</p>` : ''}
    ${!sorted.length ? '<div class="empty">No data in this range</div>' : ''}`;
}
