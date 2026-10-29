/**
 * The weather where a bot lives, so a horse that follows the weather closely
 * stands in the real fog. One free Open-Meteo call (no key) per place per
 * `ttlMinutes`, shared by every bot at the same place; the result is one
 * plain sentence for the prompt's THE WEATHER OUTSIDE line. A failed lookup
 * is null and the line is left out; nothing waits on the weather for long.
 *
 * A bot's place is `bots[].weather: { latitude, longitude, units }` in the
 * config (a real place, so it stays out of the committed persona).
 */

// WMO weather interpretation codes, as Open-Meteo returns them.
const CODES = new Map([
  [0, "clear"],
  [1, "mostly clear"],
  [2, "partly cloudy"],
  [3, "overcast"],
  [45, "fog"],
  [48, "freezing fog"],
  [51, "light drizzle"],
  [53, "drizzle"],
  [55, "heavy drizzle"],
  [56, "freezing drizzle"],
  [57, "freezing drizzle"],
  [61, "light rain"],
  [63, "rain"],
  [65, "heavy rain"],
  [66, "freezing rain"],
  [67, "freezing rain"],
  [71, "light snow"],
  [73, "snow"],
  [75, "heavy snow"],
  [77, "snow grains"],
  [80, "light showers"],
  [81, "showers"],
  [82, "heavy showers"],
  [85, "snow showers"],
  [86, "heavy snow showers"],
  [95, "a thunderstorm"],
  [96, "a thunderstorm with hail"],
  [99, "a thunderstorm with heavy hail"],
]);

function describeCode(code, isDay) {
  const text = CODES.get(Number(code));
  if (!text) return "unknown skies";
  if (code === 0 && isDay === 0) return "a clear night";
  return text;
}

/**
 * The URL for a place. Current conditions plus today's range, sunrise and
 * sunset, in the place's own zone.
 */
function forecastUrl({ latitude, longitude, units = "metric" }) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "1",
  });
  if (units === "imperial") {
    params.set("temperature_unit", "fahrenheit");
    params.set("wind_speed_unit", "mph");
    params.set("precipitation_unit", "inch");
  }
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

/** "6:04 PM" from Open-Meteo's local ISO stamp ("2026-10-28T18:04"). */
function clockOf(iso) {
  const m = String(iso || "").match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${m[2]} ${suffix}`;
}

/**
 * One sentence from an Open-Meteo answer, e.g. "overcast and 9°C (feels
 * like 6°C), wind 20 km/h, humidity 88%; today 6 to 12°C, 60% chance of
 * rain; sunset at 6:04 PM".
 * @param {Object} data - The parsed JSON
 * @returns {string|null}
 */
function describeForecast(data) {
  const cur = data?.current;
  if (!cur || typeof cur.temperature_2m !== "number") return null;
  const deg = data.current_units?.temperature_2m || "°C";
  const windUnit = data.current_units?.wind_speed_10m || "km/h";
  const t = (v) => `${Math.round(v)}${deg}`;
  const parts = [];
  let first = `${describeCode(cur.weather_code, cur.is_day)} and ${t(cur.temperature_2m)}`;
  if (typeof cur.apparent_temperature === "number" && Math.abs(cur.apparent_temperature - cur.temperature_2m) >= 3) {
    first += ` (feels like ${t(cur.apparent_temperature)})`;
  }
  parts.push(first);
  if (typeof cur.wind_speed_10m === "number" && cur.wind_speed_10m >= 15) parts.push(`wind ${Math.round(cur.wind_speed_10m)} ${windUnit}`);
  if (typeof cur.relative_humidity_2m === "number" && (cur.relative_humidity_2m >= 85 || cur.relative_humidity_2m <= 25)) {
    parts.push(`humidity ${Math.round(cur.relative_humidity_2m)}%`);
  }
  const sentence = [parts.join(", ")];

  const daily = data.daily;
  if (daily && Array.isArray(daily.temperature_2m_min) && typeof daily.temperature_2m_min[0] === "number") {
    let today = `today ${Math.round(daily.temperature_2m_min[0])} to ${t(daily.temperature_2m_max[0])}`;
    const chance = daily.precipitation_probability_max?.[0];
    if (typeof chance === "number" && chance >= 30) {
      const kind = cur.temperature_2m <= 1 ? "snow" : "rain";
      today += `, ${Math.round(chance)}% chance of ${kind}`;
    }
    sentence.push(today);
    const sunrise = clockOf(daily.sunrise?.[0]);
    const sunset = clockOf(daily.sunset?.[0]);
    if (cur.is_day === 1 && sunset) sentence.push(`sunset at ${sunset}`);
    else if (cur.is_day === 0 && sunrise) sentence.push(`sunrise at ${sunrise}`);
  }
  return sentence.join("; ");
}

class WeatherDesk {
  /**
   * @param {Object} [options]
   * @param {number} [options.ttlMinutes] - How long one answer stands
   * @param {number} [options.timeoutMs] - Give up on the API after this
   * @param {Function} [options.fetch] - fetch(url, {signal}) -> Response; injectable
   * @param {() => Date} [options.clock]
   * @param {Object} [options.logger]
   */
  constructor({ ttlMinutes = 60, timeoutMs = 8000, fetch = globalThis.fetch, clock = () => new Date(), logger = null } = {}) {
    this.ttlMs = ttlMinutes * 60000;
    this.timeoutMs = timeoutMs;
    this.fetch = fetch;
    this.clock = clock;
    this.logger = logger;
    this.cache = new Map(); // key -> { at: number, promise: Promise<string|null> }
  }

  static key(place) {
    return `${Number(place.latitude).toFixed(3)},${Number(place.longitude).toFixed(3)},${place.units || "metric"}`;
  }

  /**
   * The weather at a place, from cache when fresh.
   * @param {{latitude: number, longitude: number, units?: string}|null} place
   * @returns {Promise<string|null>}
   */
  async lookup(place) {
    if (!place || !Number.isFinite(Number(place.latitude)) || !Number.isFinite(Number(place.longitude))) return null;
    const key = WeatherDesk.key(place);
    const now = this.clock().getTime();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.promise;
    const promise = this.fetchWeather(place);
    this.cache.set(key, { at: now, promise });
    const answer = await promise;
    // A failed lookup is retried next time, not remembered for an hour.
    if (!answer) this.cache.delete(key);
    return answer;
  }

  async fetchWeather(place) {
    if (typeof this.fetch !== "function") return null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    timer?.unref?.();
    try {
      const response = await this.fetch(forecastUrl(place), controller ? { signal: controller.signal } : {});
      if (!response || !response.ok) {
        this.logger?.warn?.(`Weather lookup failed: HTTP ${response?.status}`);
        return null;
      }
      return describeForecast(await response.json());
    } catch (err) {
      this.logger?.warn?.(`Weather lookup failed: ${err.message}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = { WeatherDesk, describeForecast, forecastUrl, describeCode };
