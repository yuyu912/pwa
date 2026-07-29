export async function cutoutBlobFromOutput(output, fallbackConverter) {
  const image = Array.isArray(output) ? output[0] : output;
  if (!image) throw new Error("抠图模型没有返回可用图片");

  if (typeof image.toBlob === "function") {
    const blob = await image.toBlob();
    if (blob instanceof Blob && blob.size > 0) return blob;
    throw new Error("抠图模型返回了空图片");
  }

  if (typeof fallbackConverter !== "function") {
    throw new Error("当前浏览器无法转换抠图结果");
  }
  return fallbackConverter(image);
}
