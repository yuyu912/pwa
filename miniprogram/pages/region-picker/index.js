const region = require("../../services/weather");

Page({
  data: { provinces: [], cities: [], districts: [], provinceIndex: 0, cityIndex: 0, districtIndex: 0, keyword: "", results: [], selected: null },
  onLoad() {
    const selected = region.loadLocation();
    const provinces = region.provinces();
    const provinceIndex = Math.max(0, provinces.findIndex((item) => selected && item.code === selected.provinceCode));
    this.setData({ provinces, provinceIndex, selected });
    this.refreshChildren();
  },
  refreshChildren() {
    const province = this.data.provinces[this.data.provinceIndex];
    const cities = region.cities(province.code);
    const currentCityIndex = Math.max(0, cities.findIndex((item) => this.data.selected && item.code === this.data.selected.cityCode));
    const city = cities[currentCityIndex];
    const districts = region.districts(city.code);
    const districtIndex = Math.max(0, districts.findIndex((item) => this.data.selected && item.code === this.data.selected.districtCode));
    this.setData({ cities, districts, cityIndex: currentCityIndex, districtIndex });
  },
  onProvinceChange(event) { this.setData({ provinceIndex: Number(event.detail.value), cityIndex: 0, districtIndex: 0, selected: null }); this.refreshChildren(); },
  onCityChange(event) {
    const cityIndex = Number(event.detail.value);
    const city = this.data.cities[cityIndex];
    this.setData({ cityIndex, districtIndex: 0, districts: region.districts(city.code), selected: null });
  },
  onDistrictChange(event) { this.setData({ districtIndex: Number(event.detail.value), selected: null }); },
  onSearch(event) { const keyword = event.detail.value; this.setData({ keyword, results: region.search(keyword) }); },
  chooseResult(event) {
    const code = event.currentTarget.dataset.code;
    const path = region.getPath(code);
    const provinces = region.provinces();
    const provinceIndex = provinces.findIndex((item) => item.code === path[0].code);
    const cities = region.cities(path[0].code);
    const cityIndex = path[1] ? Math.max(0, cities.findIndex((item) => item.code === path[1].code)) : 0;
    const districts = region.districts(cities[cityIndex].code);
    const districtIndex = path[2] ? Math.max(0, districts.findIndex((item) => item.code === path[2].code)) : 0;
    this.setData({ provinces, cities, districts, provinceIndex, cityIndex, districtIndex, keyword: "", results: [] });
  },
  confirm() {
    const province = this.data.provinces[this.data.provinceIndex];
    const city = this.data.cities[this.data.cityIndex];
    const district = this.data.districts[this.data.districtIndex];
    const location = { provinceCode: province.code, provinceName: province.name, cityCode: city.code, cityName: city.name, districtCode: district.code, districtName: district.name, fullName: `${province.name} ${city.name} ${district.name}` };
    region.saveLocation(location);
    wx.navigateBack();
  }
});
