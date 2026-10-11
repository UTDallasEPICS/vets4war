/* Client-side port of db/erlang.py + db/staffing.py (staff_for_hour).
 *
 * Exists so slider moves recompute every cell without a round trip. It is a
 * deliberate duplicate of the Python, line for line, and tests/test_erlang_js.py
 * pins it to the Python output over a grid of inputs. Change both or neither.
 *
 * Field names follow the /api/forecast hour row so the page treats server
 * rows and client rows identically.
 */
const V4W = (() => {
  "use strict";
  const MAX_AGENTS = 1000;
  const SECONDS_PER_HOUR = 3600;
  const QUEUE_MASS_CUTOFF = 1e-14;
  const MAX_QUEUE_STATES = 4000;
  const MAX_QUEUE_AHEAD = 400;
  const UNIFORMIZATION_TAIL = 1e-12;
  const MAX_UNIFORMIZATION_STEPS = 100000;
  const MAX_STAFF_PER_SHIFT = 7;
  const MAX_PLAUSIBLE_STAFF = 50;
  const ZERO_EFFICIENCY_REASON =
    "efficiency is 0: no scheduled person is ever free for inbound calls, so people to schedule is undefined";

  // db/erlang.py: erlang_c
  function erlangC(agents, load) {
    if (load <= 0) return 0.0;
    if (agents <= 0 || agents <= load) return 1.0;
    let blocking = 1.0;
    for (let k = 1; k <= agents; k++) blocking = (load * blocking) / (k + load * blocking);
    const waiting = (agents * blocking) / (agents - load * (1.0 - blocking));
    return Math.min(1.0, Math.max(0.0, waiting));
  }

  // db/erlang.py: _queue_state_probabilities
  function queueStateProbabilities(agents, load, mu, theta) {
    const lam = load * mu;
    const weights = [1.0];
    let weight = 1.0, n = 1, largest = 1.0;
    for (;;) {
      const death = Math.min(n, agents) * mu + Math.max(n - agents, 0) * theta;
      weight = (weight * lam) / death;
      weights.push(weight);
      largest = Math.max(largest, weight);
      if (n > agents && weight < QUEUE_MASS_CUTOFF * largest) break;
      if (n >= agents + MAX_QUEUE_STATES) break;
      n += 1;
    }
    const total = weights.reduce((a, w) => a + w, 0);
    return weights.map((w) => w / total);
  }

  // db/erlang.py: _survives_and_answered_within (uniformization)
  function survivesAndAnsweredWithin(rates, theta, t) {
    const stages = rates.length;
    const clock = Math.max(...rates.map((r) => r + theta));
    if (clock <= 0 || t <= 0) return 0.0;
    let alive = new Array(stages).fill(0.0);
    alive[stages - 1] = 1.0;
    let answeredByStep = 0.0, poisson = Math.exp(-clock * t), cumulative = 0.0, m = 0, total = 0.0;
    while (cumulative < 1.0 - UNIFORMIZATION_TAIL) {
      total += poisson * answeredByStep;
      cumulative += poisson;
      const next = new Array(stages).fill(0.0);
      for (let i = 0; i < stages; i++) {
        const mass = alive[i];
        if (mass === 0.0) continue;
        const forward = (mass * rates[i]) / clock;
        if (i === 0) answeredByStep += forward; else next[i - 1] += forward;
        next[i] += mass * (1.0 - (rates[i] + theta) / clock);
      }
      alive = next;
      m += 1;
      poisson *= (clock * t) / m;
      if (m > MAX_UNIFORMIZATION_STEPS) break;
    }
    return Math.min(1.0, Math.max(0.0, total));
  }

  // db/erlang.py: erlang_a
  function erlangA(agents, load, ahtSec, patienceSec, targetSec) {
    if (load <= 0) return { wait_prob: 0.0, abandon_prob: 0.0, service_level: 1.0 };
    if (agents <= 0) return { wait_prob: 1.0, abandon_prob: 1.0, service_level: 0.0 };
    if (ahtSec <= 0 || patienceSec <= 0) throw new RangeError(`aht_sec and patience_sec must be > 0, got ${ahtSec}, ${patienceSec}`);
    const mu = 1.0 / ahtSec, theta = 1.0 / patienceSec;
    const pi = queueStateProbabilities(agents, load, mu, theta);
    let waitProb = 0.0, abandonProb = 0.0, answeredWithin = 0.0;
    for (let n = 0; n < pi.length; n++) {
      if (n < agents) { answeredWithin += pi[n]; continue; }
      const ahead = n - agents, p = pi[n];
      waitProb += p;
      if (ahead > MAX_QUEUE_AHEAD) { abandonProb += p; continue; }
      const rates = [];
      for (let i = 0; i <= ahead; i++) rates.push(agents * mu + i * theta);
      let survive = 1.0;
      for (const r of rates) survive *= r / (r + theta);
      abandonProb += p * (1.0 - survive);
      answeredWithin += p * survivesAndAnsweredWithin(rates, theta, targetSec);
    }
    const clamp = (x) => Math.min(1.0, Math.max(0.0, x));
    return { wait_prob: clamp(waitProb), abandon_prob: clamp(abandonProb), service_level: clamp(answeredWithin) };
  }

  // db/erlang.py: required_agents (patienceSec null = Erlang C)
  function requiredAgents(callsPerHour, ahtSec, targetPct, targetSec, patienceSec = null) {
    if (callsPerHour === 0) return 0;
    if (callsPerHour < 0) throw new RangeError(`calls_per_hour must be >= 0, got ${callsPerHour}`);
    if (ahtSec <= 0) throw new RangeError(`aht_sec must be > 0, got ${ahtSec}`);
    if (!(targetPct > 0 && targetPct <= 1)) throw new RangeError(`target_pct must be in (0, 1], got ${targetPct}`);
    if (targetSec < 0) throw new RangeError(`target_sec must be >= 0, got ${targetSec}`);
    const load = (callsPerHour * ahtSec) / SECONDS_PER_HOUR;
    if (patienceSec !== null && patienceSec <= 0) throw new RangeError(`patience_sec must be > 0, got ${patienceSec}`);
    let agents = patienceSec !== null ? 1 : Math.ceil(load) + 1;
    while (agents <= MAX_AGENTS) {
      const sl = patienceSec === null
        ? 1.0 - erlangC(agents, load) * Math.exp((-(agents - load) * targetSec) / ahtSec)
        : erlangA(agents, load, ahtSec, patienceSec, targetSec).service_level;
      if (sl >= targetPct) return agents;
      agents += 1;
    }
    throw new RangeError(`no staffing level up to ${MAX_AGENTS} agents reaches the target for load ${load}`);
  }

  // db/staffing.py: _service_level
  function serviceLevel(agents, load, ahtSec, targetSec, patienceSec = null) {
    if (agents <= 0) return 0.0;
    if (patienceSec !== null) return erlangA(agents, load, ahtSec, patienceSec, targetSec).service_level;
    return 1.0 - erlangC(agents, load) * Math.exp((-(agents - load) * targetSec) / ahtSec);
  }

  // db/staffing.py: _abandon_share
  function abandonShare(agents, load, ahtSec, targetSec, patienceSec) {
    if (patienceSec === null) return null;
    if (agents <= 0) return load > 0 ? 1.0 : 0.0;
    return erlangA(agents, load, ahtSec, patienceSec, targetSec).abandon_prob;
  }

  // db/staffing.py: schedule_people
  function schedulePeople(agentsRequired, efficiency) {
    if (!(efficiency >= 0 && efficiency <= 1)) throw new RangeError(`efficiency must be in [0, 1], got ${efficiency}`);
    if (efficiency === 0) return [null, null];
    const scheduled = Math.ceil(agentsRequired / efficiency);
    return [scheduled, Math.floor(scheduled * efficiency)];
  }

  function implausibleReason(scheduled) {
    if (scheduled <= MAX_PLAUSIBLE_STAFF) return null;
    return `${scheduled} people in one hour exceeds the plausible bound of ${MAX_PLAUSIBLE_STAFF} for this line; the efficiency input is not actionable`;
  }

  // db/staffing.py: staff_for_hour, with API hour-row field names
  function staffForHour(predictedCalls, ahtSec, efficiency, targetPct, targetSec, patienceSec = null) {
    if (predictedCalls < 0) throw new RangeError(`predicted_offered must be >= 0, got ${predictedCalls}`);
    if (patienceSec === undefined) patienceSec = null;
    const load = (predictedCalls * ahtSec) / SECONDS_PER_HOUR;
    const agents = requiredAgents(predictedCalls, ahtSec, targetPct, targetSec, patienceSec);
    const [scheduled, effective] = schedulePeople(agents, efficiency);
    const queueModel = patienceSec === null ? "erlang_c" : "erlang_a";
    const base = { predicted_calls: predictedCalls, aht_sec: ahtSec, load_erlangs: load, agents_required: agents,
                   queue_model: queueModel, patience_sec: patienceSec };
    if (scheduled === null) {
      return { ...base, staff_to_schedule: null, effective_agents: null, service_level_delivered: null,
               over_cap: null, implausible: false, reason: ZERO_EFFICIENCY_REASON, abandon_share: null };
    }
    const reason = implausibleReason(scheduled);
    return { ...base, staff_to_schedule: scheduled, effective_agents: effective,
             service_level_delivered: serviceLevel(effective, load, ahtSec, targetSec, patienceSec),
             over_cap: scheduled > MAX_STAFF_PER_SHIFT, implausible: reason !== null, reason,
             abandon_share: abandonShare(effective, load, ahtSec, targetSec, patienceSec) };
  }

  return { erlangC, erlangA, requiredAgents, serviceLevel, abandonShare, schedulePeople, staffForHour,
           MAX_STAFF_PER_SHIFT, MAX_PLAUSIBLE_STAFF, SECONDS_PER_HOUR };
})();

if (typeof module !== "undefined" && module.exports) module.exports = V4W;
