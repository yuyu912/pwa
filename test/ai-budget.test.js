import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const budget = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/ai-budget.js");

test("默认AI预算为50元、1000次、单任务预留0.05元", () => {
  const limits = budget.limitsFromEnv({});
  assert.equal(limits.totalMicros, 50_000_000);
  assert.equal(limits.taskLimit, 1000);
  assert.equal(limits.taskReservationMicros, 50_000);
  assert.equal(limits.mattingCostMicros, 10_000);
});

test("预算摘要在40元预警、45元强提醒、50元停止", () => {
  const available = budget.publicSummary({ spent_micros: 39_000_000, reserved_micros: 0, successful_tasks: 10 });
  const warning = budget.publicSummary({ spent_micros: 40_000_000, reserved_micros: 0, successful_tasks: 10 });
  const critical = budget.publicSummary({ spent_micros: 45_000_000, reserved_micros: 0, successful_tasks: 10 });
  const blocked = budget.publicSummary({ spent_micros: 50_000_000, reserved_micros: 0, successful_tasks: 10 });
  assert.equal(available.status, "available");
  assert.equal(warning.status, "warning");
  assert.equal(critical.status, "critical");
  assert.equal(blocked.status, "blocked");
});

test("千问成本使用输入和输出Token按整数微元估算", () => {
  const cost = budget.estimateQwenCostMicros(
    { prompt_tokens: 1000, completion_tokens: 200 },
    { QWEN_INPUT_YUAN_PER_MILLION: "1.5", QWEN_OUTPUT_YUAN_PER_MILLION: "4.5" }
  );
  assert.equal(cost, 2400);
});

test("成功任务达到1000次时即使金额未满也停止", () => {
  const summary = budget.publicSummary({ spent_micros: 1_000_000, reserved_micros: 0, successful_tasks: 1000 });
  assert.equal(summary.status, "blocked");
  assert.equal(summary.remainingTasks, 0);
});
