# 中国行政区离线坐标数据说明

- 数据包：`geotool-cn 2.0.1`
- PyPI：https://pypi.org/project/geotool-cn/2.0.1/
- 项目：https://github.com/13Cohen/GeoToolCN
- 官方 wheel SHA-256：`9717376f8dd6d6302770d07acf40efa8f203b82dc9f8842e2eeff7024fecbac8`
- 上游数据源：DataV.GeoAtlas（阿里云 DataV 地理小工具）
- 上游抓取日期：2026-03-07
- 坐标系：WGS-84
- 数据范围：34 个省级单位、363 个市级单位、2874 个区县
- 许可证：MIT

`china-regions.min.json` 由 `scripts/build-region-data.mjs` 从该版本 wheel
中的 `GeoToolCN/data` 目录生成，只保留名称、adcode、层级、父级和中心点坐标。

geotool-cn MIT License:

Copyright (c) 2025 Cohen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
