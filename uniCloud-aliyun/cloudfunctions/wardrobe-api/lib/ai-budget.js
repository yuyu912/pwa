"use strict";

// 金额全部使用“微元”整数：1 元 = 1,000,000 微元，避免多件衣物累计时出现浮点误差。
const DEFAULT_LIMIT_MICROS = 50 * 1000 * 1000;
const DEFAULT_TASK_LIMIT = 1000;
const DEFAULT_TASK_RESERVATION_MICROS = 50 * 1000;
const DEFAULT_MATTING_COST_MICROS = 10 * 1000;
const DEFAULT_IMAGE_EDIT_COST_MICROS = 200 * 1000;

const integer = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
};

const limitsFromEnv = (env = process.env) => ({
  totalMicros: integer(env.AI_BUDGET_TOTAL_MICROS, DEFAULT_LIMIT_MICROS),
  taskLimit: integer(env.AI_BUDGET_TASK_LIMIT, DEFAULT_TASK_LIMIT),
  taskReservationMicros: integer(env.AI_TASK_RESERVATION_MICROS, DEFAULT_TASK_RESERVATION_MICROS),
  mattingCostMicros: integer(env.AI_MATTING_COST_MICROS, DEFAULT_MATTING_COST_MICROS),
  imageEditCostMicros: integer(env.AI_IMAGE_EDIT_COST_MICROS, DEFAULT_IMAGE_EDIT_COST_MICROS)
});

// 千问返回实际输入/输出 Token 后才计算模型成本；单价由云端环境变量提供，不能写死在客户端。
const estimateQwenCostMicros = (usage = {}, env = process.env) => {
  return estimateVisionCostMicros(usage, "dashscope", env);
};

const estimateVisionCostMicros = (usage = {}, provider = "dashscope", env = process.env) => {
  const inputTokens = integer(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = integer(usage.completion_tokens ?? usage.output_tokens);
  const lyrouter = provider === "lyrouter";
  let lyrouterConfig = {};
  if (lyrouter) {
    try { lyrouterConfig = JSON.parse(String(env.LYROUTER_CONFIG || "{}")); } catch { lyrouterConfig = {}; }
  }
  // LYRouter 配置异常时采用官网原价作保守兜底；真实调用会在供应商配置校验阶段提前停止。
  const inputYuanPerMillion = Number((lyrouter ? lyrouterConfig.inputYuanPerMillion : env.QWEN_INPUT_YUAN_PER_MILLION) || (lyrouter ? 1.2 : 1));
  const outputYuanPerMillion = Number((lyrouter ? lyrouterConfig.outputYuanPerMillion : env.QWEN_OUTPUT_YUAN_PER_MILLION) || (lyrouter ? 7.2 : 10));
  const yuan = (inputTokens * inputYuanPerMillion + outputTokens * outputYuanPerMillion) / 1_000_000;
  return integer(yuan * 1_000_000);
};

// 只向前端返回可理解的预算状态，不暴露供应商密钥、单价或内部调用明细。
const publicSummary = (budget, limits = limitsFromEnv()) => {
  const spentMicros = integer(budget?.spent_micros);
  const reservedMicros = integer(budget?.reserved_micros);
  const successfulTasks = integer(budget?.successful_tasks);
  const remainingMicros = Math.max(0, limits.totalMicros - spentMicros - reservedMicros);
  const remainingTasks = Math.max(0, limits.taskLimit - successfulTasks);
  const percent = limits.totalMicros ? Math.round((spentMicros / limits.totalMicros) * 100) : 100;
  const status = spentMicros >= limits.totalMicros || successfulTasks >= limits.taskLimit
    ? "blocked"
    : spentMicros >= 45 * 1_000_000
      ? "critical"
      : spentMicros >= 40 * 1_000_000
        ? "warning"
        : "available";
  return {
    status,
    successfulTasks,
    taskLimit: limits.taskLimit,
    remainingTasks,
    spentYuan: Number((spentMicros / 1_000_000).toFixed(4)),
    remainingYuan: Number((remainingMicros / 1_000_000).toFixed(4)),
    percent
  };
};

module.exports = {
  DEFAULT_LIMIT_MICROS,
  DEFAULT_TASK_LIMIT,
  DEFAULT_TASK_RESERVATION_MICROS,
  DEFAULT_MATTING_COST_MICROS,
  DEFAULT_IMAGE_EDIT_COST_MICROS,
  estimateQwenCostMicros,
  estimateVisionCostMicros,
  integer,
  limitsFromEnv,
  publicSummary
};
