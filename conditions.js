// Conditions for the fishing journal, worked out in the browser.
// A port of journal.py (catch conditions) and barbel-conditions/dove_forecast.py (the outlook).
// Every source here allows browser requests (CORS), so no server is needed.
//
// River: EA Hydrology API, Marston on Dove (15-minute level and flow) for past catches;
//        EA flood-monitoring live gauge for "right now".
// Weather: Open-Meteo archive (past) and forecast (now and the outlook).
// Flow forecast: GloFAS via the Open-Meteo Flood API, ensemble median.

const Conditions = (() => {
  const GAUGE_GUID = "99d4811b-5177-469a-b217-732a8f1bdd13";   // EA Hydrology station
  const GAUGE_LIVE = "4018";                                    // EA flood-monitoring, same gauge
  const GAUGE = { lat: 52.8555, lon: -1.6487 };
  const TYPICAL_LOW = 0.49, TYPICAL_HIGH = 1.75;                // EA typical range (m)
  const FRESH_DAYS = 10;                                        // newer data can still be revised
  const WEATHER_POINT = { lat: 52.86, lon: -1.65 };
  const GLOFAS_CELL = { lat: 52.875, lon: -1.625 };
  const DAYS_AHEAD = 14, GAUGE_RISE_CM = 10, HEAVY_RAIN_MM = 10;
  const POINTS = {
    "First push": 4, "Fining down": 2, "Decent water": 1, "Low and clear": -1, "Big flood": -2,
    "Wet fortnight": 1, "Dry fortnight": -1, "Mild spell": 1, "Cold spell": -1,
    "Cold water": -1, "Sudden chill": -1, "Cold floodwater": -3,
  };
  const HOUR = 3600e3, DAY = 24 * HOUR;

  // ---------- small helpers
  const pad = n => String(n).padStart(2, "0");
  const round = (v, d = 0) => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 10 ** d) / 10 ** d;
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDay(d); };
  const sum = a => a.reduce((s, v) => s + v, 0);
  const mean = a => a.length ? sum(a) / a.length : NaN;
  const qs = o => new URLSearchParams(o).toString();

  async function getJson(url, params) {
    const r = await fetch(`${url}?${qs(params)}`);
    if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
    return r.json();
  }

  function compass(deg) {
    if (deg === null || deg === undefined || !isFinite(deg)) return "";
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.floor((deg + 22.5) / 45) % 8];
  }
  function trendWord(cm) {
    if (cm === null || !isFinite(cm)) return "unknown";
    return cm >= 5 ? "rising" : cm <= -5 ? "falling" : "steady";
  }
  function vsNormal(m) {
    if (m === null || !isFinite(m)) return "unknown";
    return m < TYPICAL_LOW ? "low" : m > TYPICAL_HIGH ? "high" : "normal";
  }
  function moon(iso) {
    const synodic = 29.530588853;
    const t = Date.UTC(...iso.split("-").map((v, i) => i === 1 ? v - 1 : +v), 12);
    const age = (((t - Date.UTC(2000, 0, 6, 18, 14)) / DAY) % synodic + synodic) % synodic;
    return [Math.round((1 - Math.cos(2 * Math.PI * age / synodic)) / 2 * 100), age < synodic / 2 ? "waxing" : "waning"];
  }
  function lightPhrase(when, sunrise, sunset) {
    const span = ms => { const m = Math.floor(Math.abs(ms) / 60e3); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
    if (when < sunrise) return `${span(sunrise - when)} before sunrise`;
    if (when > sunset) return `${span(when - sunset)} after sunset`;
    if (when - sunrise < sunset - when) return `${span(when - sunrise)} after sunrise`;
    return `${span(sunset - when)} before sunset`;
  }
  // Value at the reading nearest a time, within an hour. series: [[ms, value]] sorted.
  function at(series, t) {
    let best = null;
    for (const [ms, v] of series) if (best === null || Math.abs(ms - t) < Math.abs(best[0] - t)) best = [ms, v];
    return best && Math.abs(best[0] - t) <= HOUR ? best[1] : null;
  }
  // Open-Meteo hourly block -> {"2026-10-02T09:00": {col: value}}
  function hourlyMap(h) {
    const out = {};
    h.time.forEach((t, i) => { out[t] = {}; for (const k of Object.keys(h)) if (k !== "time") out[t][k] = h[k][i]; });
    return out;
  }
  const hourKey = d => `${isoDay(d)}T${pad(d.getHours())}:00`;

  function weatherAt(hourly, when) {
    // when: a local Date. Rain sums cover the hour itself and the hours before it.
    const r = {};
    const hour = new Date(when); hour.setMinutes(0, 0, 0);
    const row = hourly[hourKey(hour)];
    const prev = hourly[hourKey(new Date(hour.getTime() - DAY))];
    r.air_temp_c = row ? row.temperature_2m : null;
    r.pressure_hpa = row ? round(row.pressure_msl) : null;
    r.pressure_change_24h = row && prev ? round(row.pressure_msl - prev.pressure_msl, 1) : null;
    r.wind_kmh = row ? row.wind_speed_10m : null;
    r.wind_from = row ? compass(row.wind_direction_10m) : "";
    r.cloud_pct = row ? row.cloud_cover : null;
    const rain = hours => round(sum(Array.from({ length: hours }, (_, i) =>
      (hourly[hourKey(new Date(hour.getTime() - i * HOUR))] || {}).precipitation || 0)), 1);
    r.rain_24h_mm = rain(24);
    r.rain_72h_mm = rain(72);
    return r;
  }

  // ---------- conditions at a catch or the start of a session
  async function forCatch(date, time, lat, lon) {
    if (typeof lat !== "number") ({ lat, lon } = GAUGE);
    const when = new Date(`${date}T${time}`);
    const cacheable = new Date(date + "T12:00:00") < new Date(Date.now() - FRESH_DAYS * DAY);
    const r = {};

    const river = {};
    for (const [kind, unit] of [["level", "m"], ["flow", "m3s"]]) {
      const body = await getJson(`https://environment.data.gov.uk/hydrology/id/measures/${GAUGE_GUID}-${kind}-i-900-${unit}-qualified/readings.json`,
        { "mineq-date": addDays(date, -2), "max-date": addDays(date, 2), _limit: 2000 });
      river[kind] = (body.items || []).filter(i => typeof i.value === "number")
        .map(i => [new Date(i.dateTime.replace(/Z?$/, "Z")).getTime(), i.value]).sort((a, b) => a[0] - b[0]);
    }
    const t = when.getTime();
    const level = at(river.level, t);
    r.level_m = round(level, 3);
    for (const h of [6, 24]) {
      const before = at(river.level, t - h * HOUR);
      r[`level_change_${h}h_cm`] = level !== null && before !== null ? round((level - before) * 100, 1) : null;
    }
    r.level_trend = trendWord(r.level_change_24h_cm);
    r.level_vs_normal = vsNormal(level);
    r.flow_m3s = round(at(river.flow, t), 2);

    const wx = await getJson("https://archive-api.open-meteo.com/v1/archive", {
      latitude: lat.toFixed(3), longitude: lon.toFixed(3), start_date: addDays(date, -3), end_date: date,
      hourly: "temperature_2m,pressure_msl,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover",
      daily: "sunrise,sunset", timezone: "Europe/London",
    });
    Object.assign(r, weatherAt(hourlyMap(wx.hourly), when));
    const di = wx.daily.time.indexOf(date);
    const sunrise = new Date(wx.daily.sunrise[di]), sunset = new Date(wx.daily.sunset[di]);
    r.sunrise = wx.daily.sunrise[di].slice(11); r.sunset = wx.daily.sunset[di].slice(11);
    r.light = lightPhrase(when, sunrise, sunset);
    [r.moon_pct, r.moon_phase] = moon(date);
    r.data_note = cacheable ? "" : "Recent: figures may be revised slightly";
    r.added = isoDay(new Date());
    return r;
  }

  // ---------- right now, plus the barbel outlook
  async function now(normals) {
    const r = {};
    const since = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 19) + "Z";
    const live = await getJson(`https://environment.data.gov.uk/flood-monitoring/id/stations/${GAUGE_LIVE}/readings`,
      { since, _sorted: "", _limit: 1000 });
    const rd = (live.items || []).filter(i => typeof i.value === "number")
      .map(i => [new Date(i.dateTime).getTime(), i.value]).sort((a, b) => a[0] - b[0]);
    let rise = 0;
    if (rd.length) {
      const [lastT, last] = rd[rd.length - 1];
      const dayAgo = rd.filter(([t]) => t <= lastT - DAY);
      rise = dayAgo.length ? round((last - dayAgo[dayAgo.length - 1][1]) * 100, 1) : 0;
      r.level_m = round(last, 3);
      r.level_change_24h_cm = rise;
      r.level_trend = trendWord(rise);
      r.level_vs_normal = vsNormal(last);
      const d = new Date(lastT);
      r.reading_at = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } else {
      Object.assign(r, { level_m: null, level_change_24h_cm: null, level_trend: "unknown", level_vs_normal: "unknown", reading_at: "" });
    }

    const body = await getJson("https://api.open-meteo.com/v1/forecast", {
      latitude: GAUGE.lat, longitude: GAUGE.lon, timezone: "Europe/London",
      current: "temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,cloud_cover",
      hourly: "temperature_2m,pressure_msl,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover",
      daily: "sunrise,sunset", past_days: 3, forecast_days: 1,
    });
    const when = new Date(body.current.time);
    Object.assign(r, weatherAt(hourlyMap(body.hourly), when));
    // "current" is fresher than the hourly row, so prefer it
    r.air_temp_c = body.current.temperature_2m;
    r.wind_kmh = body.current.wind_speed_10m;
    r.wind_from = compass(body.current.wind_direction_10m);
    r.cloud_pct = body.current.cloud_cover;
    const today = isoDay(new Date()), di = body.daily.time.indexOf(today);
    r.sunrise = body.daily.sunrise[di].slice(11); r.sunset = body.daily.sunset[di].slice(11);
    r.light = lightPhrase(new Date(), new Date(body.daily.sunrise[di]), new Date(body.daily.sunset[di]));
    [r.moon_pct, r.moon_phase] = moon(today);
    r.data_note = "";

    try { r.outlook = normals ? await outlook(normals, rise) : null; }
    catch (e) { console.warn("barbel outlook skipped", e); r.outlook = null; }
    r.updated = new Date().toISOString();
    return r;
  }

  // ---------- barbel outlook (rules of thumb from dove_forecast.py)
  async function outlook(N, gaugeRiseCm) {
    const wxB = await getJson("https://api.open-meteo.com/v1/forecast", {
      latitude: WEATHER_POINT.lat, longitude: WEATHER_POINT.lon, timezone: "Europe/London",
      daily: "temperature_2m_mean,precipitation_sum,snowfall_sum", past_days: 31, forecast_days: 16,
    });
    const flB = await getJson("https://flood-api.open-meteo.com/v1/flood", {
      latitude: GLOFAS_CELL.lat, longitude: GLOFAS_CELL.lon, daily: "river_discharge_median",
      past_days: 31, forecast_days: 30,
    });
    const wx = {}; wxB.daily.time.forEach((t, i) => wx[t] = {
      temp: wxB.daily.temperature_2m_mean[i], rain: wxB.daily.precipitation_sum[i], snow: wxB.daily.snowfall_sum[i] });
    const q = {}; flB.daily.time.forEach((t, i) => { if (flB.daily.river_discharge_median[i] !== null) q[t] = flB.daily.river_discharge_median[i]; });

    const range = (d, from, to, f) => { const out = []; for (let i = from; i <= to; i++) { const v = f(addDays(d, i)); if (v !== undefined && v !== null) out.push(v); } return out; };
    const qr = (d, a, b) => range(d, a, b, k => q[k]);
    const wr = (d, a, b, col) => range(d, a, b, k => wx[k] && wx[k][col]);
    const waterEst = d => { const a = wr(d, -6, 0, "temp"); return a.length === 7 ? mean(a) : NaN; };
    const doy = d => { const x = new Date(d + "T12:00:00"); return Math.round((x - new Date(x.getFullYear(), 0, 0, 12)) / DAY); };
    const label = d => { const x = new Date(d + "T12:00:00");
      return `${x.toLocaleDateString("en-GB", { weekday: "short" })} ${pad(x.getDate())} ${x.toLocaleDateString("en-GB", { month: "short" })}`; };

    const today = isoDay(new Date());
    const days = [];
    for (let lead = 0; lead <= DAYS_AHEAD; lead++) {
      const d = addDays(today, lead);
      if (q[d] === undefined || !wx[d]) continue;
      const m = N.flow_month[String(new Date(d + "T12:00:00").getMonth() + 1)];   // p25, p50, p75, p97
      const tags = [];
      const recent = qr(d, -4, -1), before = Math.min(...qr(d, -10, -5)), week = qr(d, -7, 0);
      const rmax = Math.max(...recent), prev = q[addDays(d, -1)];
      const goodRise = rmax >= m[1] || (rmax >= 2 * before && rmax >= m[0]);
      const peaked = goodRise && q[d] < rmax && q[d] < prev;
      const rising = q[d] > 1.1 * prev;
      const gaugePush = lead === 0 && gaugeRiseCm >= GAUGE_RISE_CM;
      if (q[d] > m[3]) tags.push("Big flood");
      else if (gaugePush || (rising && (q[d] >= m[1] || (q[d] >= 2 * before && q[d] >= m[0])))) tags.push("First push");
      else if (peaked) tags.push("Fining down");
      else if (q[d] >= m[1]) tags.push("Decent water");
      else if (q[d] < m[0] && Math.max(...week) < m[1]) tags.push("Low and clear");

      const i = doy(d) - 1;
      const rain14 = wr(d, -14, -1, "rain");
      if (rain14.length === 14) {
        const v = sum(rain14);
        if (v > N.rain14_p60[i]) tags.push("Wet fortnight");
        else if (v < N.rain14_p25[i]) tags.push("Dry fortnight");
      }
      const temp5 = wr(d, -5, -1, "temp");
      if (temp5.length === 5) {
        const anom = mean(temp5) - N.temp5_mean[i];
        if (anom > 1) tags.push("Mild spell");
        else if (anom < -1.5) tags.push("Cold spell");
      }
      const we = waterEst(d);
      if (we < 5) tags.push("Cold water");
      if (we - waterEst(addDays(d, -3)) < -3) tags.push("Sudden chill");
      const snow3 = sum(wr(d, -3, 0, "snow")), cold3 = mean(wr(d, -3, 0, "temp"));
      if (q[d] > 1.2 * q[addDays(d, -3)] && (snow3 > 0.5 || cold3 < 3)) tags.push("Cold floodwater");

      const score = sum(tags.map(t => POINTS[t]));
      days.push({ date: d, day: label(d), lead, score, reasons: tags.join(", ") || "Nothing stands out",
        rating: score >= 4 ? "Good" : score >= 2 ? "Fair" : "Poor",
        confidence: lead <= 2 ? "Good" : lead <= 6 ? "Fair" : "Rough guess" });
    }

    // headlines: next fresh rise first, then heavy rain, then other good days
    const lines = [];
    const push = days.find(x => x.reasons.includes("First push"));
    if (!push) lines.push("No fresh rise in the forecast yet.");
    else {
      lines.push(`Next fresh rise: ${push.lead === 0 ? "TODAY. The river is rising now" : push.day} (confidence: ${push.confidence.toLowerCase()}).`);
      if (push.lead > 0) lines.push("It could come a day either side. Check the gauge from the day before.");
    }
    const two = d => (wx[d] && wx[addDays(d, -1)]) ? wx[d].rain + wx[addDays(d, -1)].rain : 0;
    let heavy = 0;
    for (let lead = 0; lead <= 16 && heavy < 2; lead++) {
      const d = addDays(today, lead);
      if (two(d) >= HEAVY_RAIN_MM && !(lead > 0 && two(addDays(d, -1)) >= HEAVY_RAIN_MM)) {
        lines.push(`Heavy rain due ${label(d)}: ${Math.round(two(d))} mm over 2 days. Watch for a rise after it.`);
        heavy++;
      }
    }
    const good = days.filter(x => x.rating === "Good" && !x.reasons.includes("First push")).slice(0, 3);
    if (good.length) lines.push(`Other good days: ${good.map(x => x.day).join(", ")}.`);

    const t = days[0];
    return { today: t.rating, reasons: t.reasons, lines, next: days.slice(1, 4).map(x => ({ day: x.day, rating: x.rating })) };
  }

  return { forCatch, now, FRESH_DAYS };
})();
