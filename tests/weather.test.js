const { test } = require("node:test");
const assert = require("node:assert/strict");
const { WeatherDesk, describeForecast, forecastUrl } = require("../classes/weather");

const sample = {
  current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
  current: { temperature_2m: 9.2, apparent_temperature: 5.8, relative_humidity_2m: 91, is_day: 1, weather_code: 45, wind_speed_10m: 21, cloud_cover: 100 },
  daily: { temperature_2m_min: [6.1], temperature_2m_max: [12.4], precipitation_probability_max: [60], sunrise: ["2026-10-28T07:31"], sunset: ["2026-10-28T18:04"] },
};

test("a forecast becomes one plain sentence, with only what is notable", () => {
  assert.equal(describeForecast(sample), "fog and 9°C (feels like 6°C), wind 21 km/h, humidity 91%; today 6 to 12°C, 60% chance of rain; sunset at 6:04 PM");
  const mild = { ...sample, current: { ...sample.current, apparent_temperature: 8.5, relative_humidity_2m: 60, wind_speed_10m: 5, weather_code: 2, is_day: 0 }, daily: { ...sample.daily, precipitation_probability_max: [10] } };
  assert.equal(describeForecast(mild), "partly cloudy and 9°C; today 6 to 12°C; sunrise at 7:31 AM");
  const night = { ...mild, current: { ...mild.current, weather_code: 0 } };
  assert.match(describeForecast(night), /^a clear night and 9°C/);
  const cold = { ...sample, current_units: { temperature_2m: "°F", wind_speed_10m: "mph" }, current: { ...sample.current, temperature_2m: 0.4, apparent_temperature: -5, weather_code: 71, wind_speed_10m: 18 } };
  assert.equal(describeForecast(cold), "light snow and 0°F (feels like -5°F), wind 18 mph, humidity 91%; today 6 to 12°F, 60% chance of snow; sunset at 6:04 PM");
  assert.equal(describeForecast({}), null);
  assert.equal(describeForecast(null), null);
});

test("the request asks for current conditions and today's range in the place's own zone, in the configured units", () => {
  const url = new URL(forecastUrl({ latitude: 47.6, longitude: -122.3 }));
  assert.equal(url.origin + url.pathname, "https://api.open-meteo.com/v1/forecast");
  assert.equal(url.searchParams.get("latitude"), "47.6");
  assert.equal(url.searchParams.get("timezone"), "auto");
  assert.equal(url.searchParams.get("temperature_unit"), null);
  const imperial = new URL(forecastUrl({ latitude: 47.6, longitude: -122.3, units: "imperial" }));
  assert.equal(imperial.searchParams.get("temperature_unit"), "fahrenheit");
  assert.equal(imperial.searchParams.get("wind_speed_unit"), "mph");
});

test("the desk caches one answer per place, retries failures, and never throws", async () => {
  let calls = 0;
  let now = 0;
  let ok = true;
  const fetch = async () => {
    calls++;
    return { ok, status: ok ? 200 : 503, json: async () => sample };
  };
  const desk = new WeatherDesk({ ttlMinutes: 60, fetch, clock: () => new Date(now) });
  const place = { latitude: 47.6, longitude: -122.3 };
  assert.match(await desk.lookup(place), /^fog and 9°C/);
  await desk.lookup(place);
  await desk.lookup({ latitude: 47.6001, longitude: -122.3 }, "same place to three decimals");
  assert.equal(calls, 1, "cached");
  now = 61 * 60000;
  await desk.lookup(place);
  assert.equal(calls, 2, "fresh after the ttl");
  ok = false;
  now = 2 * 61 * 60000;
  assert.equal(await desk.lookup(place), null);
  assert.equal(await desk.lookup(place), null);
  assert.equal(calls, 4, "a failure is not cached");
  assert.equal(await desk.lookup(null), null);
  assert.equal(await desk.lookup({ latitude: "x" }), null);
  const broken = new WeatherDesk({ fetch: async () => { throw new Error("offline"); } });
  assert.equal(await broken.lookup(place), null);
});
