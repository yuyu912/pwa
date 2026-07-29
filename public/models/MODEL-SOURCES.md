# 本地 AI 模型来源

这些文件随 PWA 静态发布，浏览器只从当前站点下载，不调用付费推理接口。

- `u2netp/`：来自 `BritishWerewolf/U-2-Netp`，Apache-2.0；用于本机主体蒙版。
- `mobileclip-s0/`：来自 `Xenova/mobileclip_s0` 的量化 ONNX 文件；模型页标记为 `License: other`，当前仅用于原型验证，商业化前必须重新完成许可证评估。
- `vendor/transformers.min.js` 与 `vendor/ort-wasm-simd-threaded.jsep.wasm`：`@huggingface/transformers@3.8.1`。
- `vendor/ort*`：`onnxruntime-web@1.22.0`，MIT。

上游地址：

- https://huggingface.co/BritishWerewolf/U-2-Netp
- https://huggingface.co/Xenova/mobileclip_s0
- https://www.npmjs.com/package/@huggingface/transformers/v/3.8.1
- https://www.npmjs.com/package/onnxruntime-web/v/1.22.0
