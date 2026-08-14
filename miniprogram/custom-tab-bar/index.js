Component({
  data: {
    selected: 0,
    tabs: [
      { pagePath: "/pages/home/index", text: "首页", icon: "home" },
      { pagePath: "/pages/inspiration/index", text: "灵感", icon: "bulb" },
      { pagePath: "/pages/wear-calendar/index", text: "日历", icon: "calendar" },
      { pagePath: "/pages/account/index", text: "我的", icon: "mine" }
    ]
  },
  methods: {
    switchTab(event) {
      const { path, index } = event.currentTarget.dataset;
      if (Number(index) === this.data.selected) return;
      wx.switchTab({ url: path });
    }
  }
});
