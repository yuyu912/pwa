const forms = document.querySelectorAll("[data-ai-form]");
const scenes = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const appMessage = document.querySelector("#app-message");

const showMessage = (text, isError = false) => {
  appMessage.textContent = text;
  appMessage.classList.toggle("error", isError);
};

const splitTags = (value) => String(value || "").split("，").join(",").split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 4);

const renderStyleTags = (form) => {
  const input = form.elements.styles;
  const list = form.querySelector("[data-style-tags]");
  list.replaceChildren();
  splitTags(input.value).forEach((style) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.append(style);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `删除${style}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      input.value = splitTags(input.value).filter((item) => item !== style).join("，");
      renderStyleTags(form);
    });
    tag.append(remove);
    list.append(tag);
  });
};

const renderScenes = (form) => {
  const input = form.elements.scenes;
  const list = form.querySelector("[data-scene-options]");
  const selected = new Set(splitTags(input.value));
  list.replaceChildren();
  scenes.forEach((scene) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `scene-option${selected.has(scene) ? " active" : ""}`;
    button.textContent = scene;
    button.addEventListener("click", () => {
      selected.has(scene) ? selected.delete(scene) : selected.add(scene);
      input.value = [...selected].join("，");
      renderScenes(form);
    });
    list.append(button);
  });
};

const prepareConfirmation = (form, draft) => {
  const { tags } = draft;
  form.elements.draftId.value = draft.draftId;
  form.elements.name.value = tags.name || "";
  form.elements.category.value = tags.category || "";
  form.elements.color.value = tags.color || "";
  form.elements.styles.value = (tags.styles || []).join("，");
  form.elements.scenes.value = (tags.scenes || []).join("，");
  form.elements.name.required = true;
  form.elements.category.required = true;
  const confirmation = form.querySelector(".ai-confirmation");
  const note = form.querySelector("[data-ai-intro]");
  note.textContent = tags.needsConfirmation?.length
    ? `衣衣已整理标签。请重点确认：${tags.needsConfirmation.join("；")}`
    : "衣衣已整理标签。请按实物确认，所有内容都可修改。";
  confirmation.hidden = false;
  form.dataset.aiReady = "true";
  form.querySelector("[data-ai-submit]").textContent = form.id === "item-form" ? "确认并保存到衣橱" : "确认并查看衣橱依据";
  renderStyleTags(form);
  renderScenes(form);
};

const resetAiForm = (form) => {
  delete form.dataset.aiReady;
  form.elements.draftId.value = "";
  form.elements.name.required = false;
  form.elements.category.required = false;
  form.querySelector(".ai-confirmation").hidden = true;
  form.querySelector("[data-ai-submit]").textContent = form.id === "item-form" ? "AI 识别衣物" : "AI 识别候选新衣";
};

forms.forEach((form) => {
  form.elements.styles.addEventListener("input", () => renderStyleTags(form));
  form.addEventListener("reset", () => window.setTimeout(() => resetAiForm(form), 0));
  form.addEventListener("invalid", (event) => {
    if (["name", "category"].includes(event.target.name)) showMessage("请先确认衣物名称和品类，再保存。", true);
  }, true);
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-ai-form]");
  if (!form || form.dataset.aiReady === "true") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const file = form.elements.image.files?.[0];
  if (!file) return showMessage("请先选择一张衣物图片。", true);
  const button = form.querySelector("[data-ai-submit]");
  let stage = "读取照片";
  button.disabled = true;
  button.textContent = "正在识别…";
  showMessage("正在识别衣物信息，请稍候。", false);
  try {
    stage = "生成上传表单";
    let result;
    const compressed = await window.wardrobeCompress(file);
    if (window.wardrobeCloudApiMode) {
      stage = "申请安全上传地址";
      const upload = await window.wardrobeApi("/api/uploads/presign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mimeType: compressed.type, size: compressed.size })
      });
      stage = "上传照片";
      const uploaded = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "content-type": compressed.type },
        body: compressed
      });
      if (!uploaded.ok) throw new Error(`图片上传未完成（状态 ${uploaded.status}），请检查 COS 跨域设置。`);
      stage = "云端识别";
      result = await window.wardrobeApi("/api/recognize", {
        method: "POST",
        timeoutMs: 120000,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceKey: upload.sourceKey, mode: form.id === "candidate-form" ? "candidate" : "closet" })
      });
    } else {
      const data = new FormData(form);
      data.set("image", compressed);
      data.set("mode", form.id === "candidate-form" ? "candidate" : "closet");
      stage = "发送识别请求";
      result = await window.wardrobeApi("/api/recognize", { method: "POST", timeoutMs: 120000, body: data });
    }
    prepareConfirmation(form, result);
    const warning = result.duplicate?.type === "warning"
      ? `发现相似衣物“${result.duplicate.item.name}”（${Math.round(result.duplicate.score)}%），请确认不是同一件。`
      : result.warning || "识别完成，请确认标签后再保存。";
    showMessage(warning, false);
  } catch (error) {
    const item = error.data?.duplicate?.item;
    if (item) return showMessage(`已录入相似衣物：${item.name}（相似度 ${Math.round(error.data.duplicate.score)}%）。`, true);
    showMessage(`${stage}失败：${error.message}`, true);
  } finally {
    button.disabled = false;
    if (form.dataset.aiReady !== "true") button.textContent = form.id === "item-form" ? "AI 识别衣物" : "AI 识别候选新衣";
  }
}, true);
