import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { normalizeLive } = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/amap-weather.js");
const homeWeatherSource = fs.readFileSync(new URL("../miniprogram/utils/home-weather.js", import.meta.url), "utf8");
const homeWeatherModule = { exports: {} };
vm.runInNewContext(homeWeatherSource, { module: homeWeatherModule, exports: homeWeatherModule.exports });
const { getWeatherIcon } = homeWeatherModule.exports;
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

test("首页按天气文字稳定切换手绘图标", () => {
  assert.equal(getWeatherIcon("晴"), "sun");
  assert.equal(getWeatherIcon("多云"), "cloud");
  assert.equal(getWeatherIcon("阴"), "cloud");
  assert.equal(getWeatherIcon("雷阵雨"), "rain");
  assert.equal(getWeatherIcon("雨夹雪"), "snow");
  assert.equal(getWeatherIcon("大风"), "wind");
  assert.equal(getWeatherIcon("雾霾"), "haze");
  assert.equal(getWeatherIcon("晴转多云"), "cloud");
  assert.equal(getWeatherIcon("未知天气"), "cloud");
});

test("首页使用 Wardrobloom 手写品牌、衣橱小屋和精简入口", () => {
  const markup = fs.readFileSync(new URL("../miniprogram/pages/home/index.wxml", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../miniprogram/pages/home/index.wxss", import.meta.url), "utf8");
  const weatherMarkup = fs.readFileSync(new URL("../miniprogram/pages/weather/index.wxml", import.meta.url), "utf8");
  const todayMarkup = fs.readFileSync(new URL("../miniprogram/pages/today-outfit/index.wxml", import.meta.url), "utf8");
  const wardrobeMarkup = fs.readFileSync(new URL("../miniprogram/pages/wardrobe/index.wxml", import.meta.url), "utf8");
  const appConfig = JSON.parse(fs.readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8"));
  const loginConfig = JSON.parse(fs.readFileSync(new URL("../miniprogram/pages/login/index.json", import.meta.url), "utf8"));
  assert.match(markup, /home-brand-wardrobloom-v1\.jpg/);
  assert.doesNotMatch(markup, /brand-hanger|衣橱关系/);
  assert.match(markup, /home-wardrobe-house-v2\.jpg/);
  assert.equal(fs.existsSync(new URL("../miniprogram/assets/home-wardrobe-house-v2.jpg", import.meta.url)), true);
  assert.equal(fs.existsSync(new URL("../miniprogram/assets/home-brand-wardrobloom-v1.jpg", import.meta.url)), true);
  assert.match(markup, /weather-\{\{weatherIcon\}\}\.png/);
  assert.match(weatherMarkup, /page weather-page/);
  assert.match(todayMarkup, /page today-outfit-page/);
  assert.match(wardrobeMarkup, /page wardrobe-page/);
  for (const icon of ["sun", "cloud", "rain", "snow", "wind", "haze"]) {
    assert.equal(fs.existsSync(new URL(`../miniprogram/assets/weather-${icon}.png`, import.meta.url)), true);
  }
  assert.doesNotMatch(markup, /粘贴穿搭分享链接|看看我的衣橱能不能搭|class="bottom-nav"/);
  assert.match(markup, /＋ 录入衣物/);
  assert.ok(markup.indexOf("＋ 录入衣物") < markup.indexOf('class="entry-grid"'));
  assert.match(markup, /home-entry-wardrobe-v2\.jpg/);
  assert.match(markup, /home-entry-outfit-v2\.jpg/);
  assert.match(markup, /bindtap="toOutfitGallery"[\s\S]*?>我的搭配</);
  assert.doesNotMatch(markup, /entry-subtitle|已收录|查看保存过的搭配方案/);
  assert.match(styles, /font-family: "Kaiti SC", "STKaiti", "KaiTi", "FangSong", serif;/);
  assert.doesNotMatch(markup, /entry-arrow/);
  assert.equal(appConfig.window.navigationBarTitleText, "Wardrobloom");
  assert.equal(appConfig.tabBar.custom, true);
  assert.deepEqual(appConfig.tabBar.list.map((item) => item.text), ["首页", "灵感", "日历", "我的"]);
  assert.equal(loginConfig.navigationBarTitleText, "登录 Wardrobloom");
});

test("全局底部导航使用 Tab 兼容路由并同步选中态", () => {
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
  const app = JSON.parse(read("../miniprogram/app.json"));
  const component = read("../miniprogram/custom-tab-bar/index.js");
  const markup = read("../miniprogram/custom-tab-bar/index.wxml");
  const styles = read("../miniprogram/custom-tab-bar/index.wxss");
  const pages = ["home", "inspiration", "wear-calendar", "account"].map((name) => read(`../miniprogram/pages/${name}/index.js`));
  const login = read("../miniprogram/pages/login/index.js");
  const detail = read("../miniprogram/pages/outfit-detail/index.js");
  assert.deepEqual(app.tabBar.list.map((item) => item.text), ["首页", "灵感", "日历", "我的"]);
  assert.match(component, /wx\.switchTab\(\{ url: path \}\)/);
  assert.match(markup, /item\.icon === 'calendar'/);
  assert.match(styles, /\.tab-item\.active \{ color: #bd7381;/);
  assert.doesNotMatch(styles, /#8e79b5/);
  pages.forEach((source, index) => assert.match(source, new RegExp(`setData\\(\\{ selected: ${index} \\}\\)`)));
  assert.match(login, /wx\.switchTab\(\{ url: "\/pages\/home\/index" \}\)/);
  assert.match(detail, /wx\.switchTab\(\{ url: "\/pages\/wear-calendar\/index" \}\)/);
});
