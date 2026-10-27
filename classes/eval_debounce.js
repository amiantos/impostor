/**
 * When a pending channel evaluation should fire.
 *
 * Every new line pushes the evaluation back by `debounce_seconds` so the bot
 * reads a settled conversation rather than half of one. A pure reset starves
 * him in a busy channel: with a line every few seconds the timer never fires,
 * even when someone has asked him a question. So a wait also has a deadline,
 * fixed when the first line started it, that later lines cannot push past:
 *
 *   - `max_wait_seconds`     the deadline for ordinary chatter
 *   - `address_wait_seconds` a line that names him pulls the deadline in
 *
 * The timer fires at the earlier of the next debounce and the deadline. Once
 * it fires the wait is over; the next line starts a fresh one.
 */

const DEFAULTS = {
  debounce_seconds: 20,
  max_wait_seconds: 60,
  address_wait_seconds: 5,
};

function seconds(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Resolve the three waits from an `autonomous` config section, in ms.
 * @param {Object} [autonomous]
 * @returns {{debounceMs:number, maxWaitMs:number, addressWaitMs:number}}
 */
function debounceConfig(autonomous = {}) {
  return {
    debounceMs: seconds(autonomous.debounce_seconds, DEFAULTS.debounce_seconds) * 1000,
    maxWaitMs: seconds(autonomous.max_wait_seconds, DEFAULTS.max_wait_seconds) * 1000,
    addressWaitMs:
      seconds(autonomous.address_wait_seconds, DEFAULTS.address_wait_seconds) * 1000,
  };
}

/**
 * Plan the next firing of a channel's evaluation timer.
 * @param {Object} args
 * @param {number} args.now - Current time, ms
 * @param {number|null} args.deadline - Deadline of the wait in progress, or null if none
 * @param {boolean} args.addressed - Whether the new line names the bot
 * @param {{debounceMs:number, maxWaitMs:number, addressWaitMs:number}} args.cfg
 * @returns {{fireAt:number, deadline:number}} When to fire, and the wait's (possibly tightened) deadline
 */
function planEvaluation({ now, deadline, addressed, cfg }) {
  let next = deadline ?? now + cfg.maxWaitMs;
  if (addressed) next = Math.min(next, now + cfg.addressWaitMs);
  const fireAt = Math.min(now + cfg.debounceMs, next);
  return { fireAt, deadline: next };
}

module.exports = { DEFAULTS, debounceConfig, planEvaluation };
