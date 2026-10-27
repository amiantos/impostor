const { test } = require("node:test");
const assert = require("node:assert/strict");
const { debounceConfig, planEvaluation } = require("../classes/eval_debounce");

const cfg = debounceConfig({
  debounce_seconds: 20,
  max_wait_seconds: 60,
  address_wait_seconds: 5,
});

test("a first line fires after the debounce and starts a max-wait deadline", () => {
  const plan = planEvaluation({ now: 1000, deadline: null, addressed: false, cfg });
  assert.equal(plan.fireAt, 21000);
  assert.equal(plan.deadline, 61000);
});

test("later lines push the timer back but never past the deadline", () => {
  let plan = planEvaluation({ now: 0, deadline: null, addressed: false, cfg });
  let now = 0;
  // A line every 10s in a busy channel: the debounce alone would never fire.
  for (let i = 0; i < 20; i++) {
    now += 10000;
    plan = planEvaluation({ now, deadline: plan.deadline, addressed: false, cfg });
    assert.ok(plan.fireAt <= 60000, `fired at ${plan.fireAt} after line at ${now}`);
    assert.equal(plan.deadline, 60000);
  }
  // At 50s the next debounce (70s) is capped by the deadline.
  assert.equal(
    planEvaluation({ now: 50000, deadline: 60000, addressed: false, cfg }).fireAt,
    60000
  );
});

test("a line that names the bot pulls the deadline in to the address wait", () => {
  const plan = planEvaluation({ now: 10000, deadline: 60000, addressed: true, cfg });
  assert.equal(plan.deadline, 15000);
  assert.equal(plan.fireAt, 15000);
  // Chatter after the mention cannot push it back out.
  const later = planEvaluation({ now: 12000, deadline: plan.deadline, addressed: false, cfg });
  assert.equal(later.fireAt, 15000);
  assert.equal(later.deadline, 15000);
});

test("an address never loosens a deadline that is already sooner", () => {
  const plan = planEvaluation({ now: 10000, deadline: 12000, addressed: true, cfg });
  assert.equal(plan.deadline, 12000);
  assert.equal(plan.fireAt, 12000);
});

test("an address with no wait in progress still fires quickly", () => {
  const plan = planEvaluation({ now: 0, deadline: null, addressed: true, cfg });
  assert.equal(plan.fireAt, 5000);
  assert.equal(plan.deadline, 5000);
});

test("a short debounce is not stretched to the address wait", () => {
  const quick = debounceConfig({ debounce_seconds: 2, address_wait_seconds: 5 });
  const plan = planEvaluation({ now: 0, deadline: null, addressed: true, cfg: quick });
  assert.equal(plan.fireAt, 2000);
});

test("debounceConfig falls back to defaults for missing or bad values", () => {
  assert.deepEqual(debounceConfig(undefined), {
    debounceMs: 20000,
    maxWaitMs: 60000,
    addressWaitMs: 5000,
  });
  assert.deepEqual(
    debounceConfig({ debounce_seconds: "20", max_wait_seconds: 0, address_wait_seconds: -1 }),
    { debounceMs: 20000, maxWaitMs: 60000, addressWaitMs: 5000 }
  );
  assert.equal(debounceConfig({ debounce_seconds: 3 }).debounceMs, 3000);
});
