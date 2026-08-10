import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { normalizeLive } = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/amap-weather.js");
const weatherSource = fs.readFileSync(new URL("../miniprogram/services/weather.js", import.meta.url), "utf8");
const weatherModule = { exports: {} };
vm.runInNewContext(weatherSource, {
  module: weatherModule,
  exports: weatherModule.exports,
  require: () => ({ areaList: { province_list: {}, city_list: {}, county_list: {} } })
});
const weather = weatherModule.exports;

test("高德实况天气只保留搭配需要的安全字段", () => {
  const result = normalizeLive({
    status: "1",
    lives: [{
      province: "广东",
      city: "深圳市",
      adcode: "440305",
      weather: "多云",
      temperature: "27",
      winddirection: "东南",
      windpower: "3",
      humidity: "72",
      reporttime: "2026-08-04 12:00:00"
    }]
  });
  assert.equal(result.temperature, 27);
  assert.equal(result.condition, "多云");
  assert.equal(result.humidity, "72");
  assert.equal(result.reportTime, "2026-08-04 12:00:00");
});

test("无效供应商结果不会伪造成实时天气", () => {
  assert.throws(
    () => normalizeLive({ status: "0", infocode: "10003", lives: [] }),
    (error) => error.status === 502 && error.code === "10003"
  );
});

test("实时温度和降水会进入衣橱搭配规则", () => {
  const result = weather.formatLiveWeather(
    { city: "深圳市", condition: "小雨", temperature: 18, reportTime: "2026-08-04 12:00:00" },
    { cityName: "深圳市", fullName: "广东省 深圳市 南山区" }
  );
  assert.equal(result.high, 18);
  assert.equal(result.needsOuterwear, true);
  assert.match(result.tip, /降水/);
});

test("手动天气会覆盖温度和天气类型并重新计算搭配提示", () => {
  const live = weather.formatLiveWeather(
    { city: "杭州市", condition: "晴", temperature: 24, reportTime: "2026-08-10 10:20:00" },
    { cityName: "杭州市", fullName: "浙江省 杭州市 西湖区" }
  );
  const result = weather.applyWeatherOverride(live, { condition: "小雨", temperature: 15 });
  assert.equal(result.condition, "小雨");
  assert.equal(result.temperature, 15);
  assert.equal(result.high, 15);
  assert.equal(result.needsOuterwear, true);
  assert.equal(result.isManual, true);
  assert.equal(result.liveCondition, "晴");
  assert.equal(result.liveTemperature, 24);
  assert.match(result.tip, /降水/);
});

test("手动天气只在同一地区和同一天有效", () => {
  const location = { districtCode: "330106", cityName: "杭州市" };
  const override = weather.createWeatherOverride(location, "大风", 12, new Date(2026, 7, 10, 9));
  assert.equal(weather.isWeatherOverrideValid(override, location, new Date(2026, 7, 10, 23, 59)), true);
  assert.equal(weather.isWeatherOverrideValid(override, { districtCode: "330108" }, new Date(2026, 7, 10, 9)), false);
  assert.equal(weather.isWeatherOverrideValid(override, location, new Date(2026, 7, 11, 0, 1)), false);
});

test("手动温度被限制在安全范围且天气选项完整", () => {
  const location = { districtCode: "330106" };
  assert.equal(weather.createWeatherOverride(location, "晴", 99).temperature, 50);
  assert.equal(weather.createWeatherOverride(location, "雪", -99).temperature, -30);
  assert.deepEqual(Array.from(weather.WEATHER_CONDITIONS), [
    "晴", "多云", "阴", "阵雨", "小雨", "中雨", "大雨", "雷雨", "雨夹雪", "雪", "雾霾", "大风"
  ]);
});

test("大风天气会提示轻外套，雾霾只按温度选择衣物", () => {
  const location = { cityName: "杭州市", fullName: "浙江省 杭州市 西湖区" };
  const windy = weather.formatLiveWeather({ condition: "大风", temperature: 24 }, location);
  const hazy = weather.formatLiveWeather({ condition: "雾霾", temperature: 24 }, location);
  assert.equal(windy.needsOuterwear, true);
  assert.match(windy.tip, /轻外套/);
  assert.equal(hazy.needsOuterwear, false);
  assert.match(hazy.tip, /空气质量/);
});
