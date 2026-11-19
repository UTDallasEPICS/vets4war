// Erlang C and Erlang A staffing math. A line-for-line port of final-main's
// db/erlang.py (through its JS twin web/erlang.js). The order of floating-point
// operations is kept on purpose: tests/parity/staffing compares every result with
// the Python to 1e-9. Change both or neither.
//
//   load (erlangs) = calls_per_hour * aht_sec / 3600 = average number of agents busy
//   service level  = share of ALL arriving callers answered within target_sec; under
//                    Erlang A a caller who hangs up counts as not answered.

// Hard stop for the search in requiredAgents: hitting it means absurd inputs
// (e.g. target_pct = 1), not that more agents are needed.
export const MAX_AGENTS = 1000
export const SECONDS_PER_HOUR = 3600

// Erlang A state chain: stop adding queue states once their mass is this small
// relative to the largest state, or at this many states.
const QUEUE_MASS_CUTOFF = 1e-14
const MAX_QUEUE_STATES = 4000
// Beyond this many callers ahead the work is not worth the negligible mass; it is
// counted as abandoned.
const MAX_QUEUE_AHEAD = 400
// Uniformization stops once the Poisson weights have covered this much mass.
const UNIFORMIZATION_TAIL = 1e-12
const MAX_UNIFORMIZATION_STEPS = 100000

interface ErlangAResult {
  wait_prob: number
  abandon_prob: number
  service_level: number
}

const clamp = (x: number) => Math.min(1.0, Math.max(0.0, x))

// Probability an arriving call waits (M/M/N), through the Erlang B recurrence, which
// never forms a factorial and so never overflows.
export function erlangC(agents: number, load: number): number {
  if (load <= 0) return 0.0
  if (agents <= 0 || agents <= load) return 1.0
  let blocking = 1.0
  for (let k = 1; k <= agents; k++) blocking = (load * blocking) / (k + load * blocking)
  const waiting = (agents * blocking) / (agents - load * (1.0 - blocking))
  return Math.min(1.0, Math.max(0.0, waiting))
}

// Stationary probabilities of n calls in the system for the birth-death chain with
// arrival rate load * mu, service min(n, N) * mu and abandonment max(n - N, 0) * theta.
function queueStateProbabilities(
  agents: number,
  load: number,
  mu: number,
  theta: number
): number[] {
  const lam = load * mu
  const weights = [1.0]
  let weight = 1.0
  let n = 1
  let largest = 1.0
  for (;;) {
    const death = Math.min(n, agents) * mu + Math.max(n - agents, 0) * theta
    weight = (weight * lam) / death
    weights.push(weight)
    largest = Math.max(largest, weight)
    if (n > agents && weight < QUEUE_MASS_CUTOFF * largest) break
    if (n >= agents + MAX_QUEUE_STATES) break
    n += 1
  }
  const total = weights.reduce((a, w) => a + w, 0)
  return weights.map((w) => w / total)
}

// P(V <= t and patience > V), V = sum of independent Exp(rates) (stage i = i callers
// still ahead), the caller's own patience Exp(theta). Uniformization: every term is
// positive, so it stays stable when the stage rates are nearly equal.
function survivesAndAnsweredWithin(rates: number[], theta: number, t: number): number {
  const stages = rates.length
  const clock = Math.max(...rates.map((r) => r + theta))
  if (clock <= 0 || t <= 0) return 0.0
  let alive: number[] = new Array(stages).fill(0.0)
  alive[stages - 1] = 1.0
  let answeredByStep = 0.0
  let poisson = Math.exp(-clock * t)
  let cumulative = 0.0
  let m = 0
  let total = 0.0
  while (cumulative < 1.0 - UNIFORMIZATION_TAIL) {
    total += poisson * answeredByStep
    cumulative += poisson
    const next: number[] = new Array(stages).fill(0.0)
    for (let i = 0; i < stages; i++) {
      const mass = alive[i]!
      if (mass === 0.0) continue
      const rate = rates[i]!
      const forward = (mass * rate) / clock
      if (i === 0) answeredByStep += forward
      else next[i - 1] = next[i - 1]! + forward
      next[i] = next[i]! + mass * (1.0 - (rate + theta) / clock)
    }
    alive = next
    m += 1
    poisson *= (clock * t) / m
    if (m > MAX_UNIFORMIZATION_STEPS) break
  }
  return Math.min(1.0, Math.max(0.0, total))
}

// Erlang A (M/M/N+M): callers hang up after an Exp(patienceSec) wait.
export function erlangA(
  agents: number,
  load: number,
  ahtSec: number,
  patienceSec: number,
  targetSec: number
): ErlangAResult {
  if (load <= 0) return { wait_prob: 0.0, abandon_prob: 0.0, service_level: 1.0 }
  if (agents <= 0) return { wait_prob: 1.0, abandon_prob: 1.0, service_level: 0.0 }
  if (ahtSec <= 0 || patienceSec <= 0) {
    throw new RangeError(`aht_sec and patience_sec must be > 0, got ${ahtSec}, ${patienceSec}`)
  }
  const mu = 1.0 / ahtSec
  const theta = 1.0 / patienceSec
  const pi = queueStateProbabilities(agents, load, mu, theta)
  let waitProb = 0.0
  let abandonProb = 0.0
  let answeredWithin = 0.0
  for (let n = 0; n < pi.length; n++) {
    const p = pi[n]!
    if (n < agents) {
      answeredWithin += p
      continue
    }
    const ahead = n - agents
    waitProb += p
    if (ahead > MAX_QUEUE_AHEAD) {
      abandonProb += p
      continue
    }
    const rates: number[] = []
    for (let i = 0; i <= ahead; i++) rates.push(agents * mu + i * theta)
    let survive = 1.0
    for (const r of rates) survive *= r / (r + theta)
    abandonProb += p * (1.0 - survive)
    answeredWithin += p * survivesAndAnsweredWithin(rates, theta, targetSec)
  }
  return {
    wait_prob: clamp(waitProb),
    abandon_prob: clamp(abandonProb),
    service_level: clamp(answeredWithin),
  }
}

// Smallest agent count that answers targetPct of calls within targetSec. Erlang C when
// patienceSec is null (search starts at the first stable level), Erlang A otherwise
// (stable at any N because callers hang up, so the search starts at 1).
export function requiredAgents(
  callsPerHour: number,
  ahtSec: number,
  targetPct: number = 0.8,
  targetSec: number = 30,
  patienceSec: number | null = null
): number {
  if (callsPerHour === 0) return 0
  if (callsPerHour < 0) throw new RangeError(`calls_per_hour must be >= 0, got ${callsPerHour}`)
  if (ahtSec <= 0) throw new RangeError(`aht_sec must be > 0, got ${ahtSec}`)
  if (!(targetPct > 0 && targetPct <= 1)) {
    throw new RangeError(`target_pct must be in (0, 1], got ${targetPct}`)
  }
  if (targetSec < 0) throw new RangeError(`target_sec must be >= 0, got ${targetSec}`)
  const load = (callsPerHour * ahtSec) / SECONDS_PER_HOUR
  if (patienceSec !== null && patienceSec <= 0) {
    throw new RangeError(`patience_sec must be > 0, got ${patienceSec}`)
  }
  let agents = patienceSec !== null ? 1 : Math.ceil(load) + 1
  while (agents <= MAX_AGENTS) {
    const sl =
      patienceSec === null
        ? 1.0 - erlangC(agents, load) * Math.exp((-(agents - load) * targetSec) / ahtSec)
        : erlangA(agents, load, ahtSec, patienceSec, targetSec).service_level
    if (sl >= targetPct) return agents
    agents += 1
  }
  throw new RangeError(
    `no staffing level up to ${MAX_AGENTS} agents reaches the target for load ${load}`
  )
}
