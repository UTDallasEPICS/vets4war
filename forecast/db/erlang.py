"""Erlang C and Erlang A staffing math for the Vets4Warriors call volume tool.

Pure math, no database access, no imports from other project files.

    erlang_c(agents, load)          -> probability an arriving call waits
                                       (M/M/N: nobody ever hangs up)
    erlang_a(agents, load, aht_sec,
             patience_sec, target_sec)
                                    -> dict: wait_prob, abandon_prob,
                                       service_level  (M/M/N+M: callers
                                       hang up after Exp(patience) waiting)
    required_agents(calls_per_hour, aht_sec, target_pct, target_sec,
                    patience_sec=None)
                                    -> smallest agent count meeting the
                                       service-level target; Erlang C when
                                       patience_sec is None, Erlang A otherwise

Terminology:
    load (erlangs) = calls_per_hour * aht_sec / 3600
                   = average number of agents busy at once.
    service level  = share of ALL arriving callers answered within
                     target_sec. Under Erlang A a caller who hangs up
                     counts as not answered.
"""

from __future__ import annotations

import math

# Hard stop for the search loop in required_agents. Erlang C falls off
# quickly once agents > load, so hitting this means the inputs are absurd
# (e.g. target_pct = 1.0), not that we need more agents.
MAX_AGENTS = 1000
SECONDS_PER_HOUR = 3600.0

# Erlang A state chain: stop adding queue states once their probability
# mass is this small relative to the largest state, or at this many states.
QUEUE_MASS_CUTOFF = 1e-14
MAX_QUEUE_STATES = 4000
# Beyond this many callers ahead the per-state work is not worth the
# negligible probability mass; it is counted as abandoned.
MAX_QUEUE_AHEAD = 400
# Uniformization stops once the Poisson weights have covered this much mass.
UNIFORMIZATION_TAIL = 1e-12
MAX_UNIFORMIZATION_STEPS = 100_000


def erlang_c(agents: int, load: float) -> float:
    """Probability an arriving call has to wait (Erlang C), for `agents`
    servers and offered `load` in erlangs.

    Computed by walking the Erlang B recurrence

        B(0, A) = 1
        B(k, A) = A * B(k-1, A) / (k + A * B(k-1, A))

    up to k = agents, then converting

        C(N, A) = N * B / (N - A * (1 - B))

    The recurrence never forms a factorial, so it does not overflow.

    Edge cases:
        load <= 0            -> 0.0 (nobody waits when nobody calls)
        agents <= load       -> 1.0 (queue is unstable; everyone waits)
    """
    if load <= 0:
        return 0.0
    if agents <= 0 or agents <= load:
        return 1.0

    blocking = 1.0
    for k in range(1, agents + 1):
        blocking = load * blocking / (k + load * blocking)

    waiting = agents * blocking / (agents - load * (1.0 - blocking))
    # Floating-point can nudge the result a hair outside [0, 1].
    return min(1.0, max(0.0, waiting))


def required_agents(
    calls_per_hour: float,
    aht_sec: float,
    target_pct: float = 0.80,
    target_sec: float = 30,
    patience_sec: float | None = None,
) -> int:
    """Smallest number of agents such that at least `target_pct` of calls
    are answered within `target_sec` seconds.

    Erlang C (patience_sec is None):
        service_level = 1 - C(N, A) * exp(-(N - A) * target_sec / aht_sec)
        Search starts at ceil(load) + 1 (the first stable staffing level).

    Erlang A (patience_sec given):
        service_level from erlang_a(); the queue is stable at any N because
        callers hang up, so the search starts at 1 agent.

    Returns 0 when calls_per_hour == 0.
    """
    if calls_per_hour == 0:
        return 0
    if calls_per_hour < 0:
        raise ValueError(f"calls_per_hour must be >= 0, got {calls_per_hour}")
    if aht_sec <= 0:
        raise ValueError(f"aht_sec must be > 0, got {aht_sec}")
    if not 0 < target_pct <= 1:
        raise ValueError(f"target_pct must be in (0, 1], got {target_pct}")
    if target_sec < 0:
        raise ValueError(f"target_sec must be >= 0, got {target_sec}")

    load = calls_per_hour * aht_sec / SECONDS_PER_HOUR
    if patience_sec is not None and patience_sec <= 0:
        raise ValueError(f"patience_sec must be > 0, got {patience_sec}")
    agents = 1 if patience_sec is not None else math.ceil(load) + 1

    while agents <= MAX_AGENTS:
        if patience_sec is None:
            wait_prob = erlang_c(agents, load)
            service_level = 1.0 - wait_prob * math.exp(
                -(agents - load) * target_sec / aht_sec
            )
        else:
            service_level = erlang_a(agents, load, aht_sec, patience_sec, target_sec)["service_level"]
        if service_level >= target_pct:
            return agents
        agents += 1

    raise ValueError(
        f"no staffing level up to {MAX_AGENTS} agents reaches "
        f"{target_pct:.0%} within {target_sec}s for load {load:.2f} erlangs"
    )


# =============================================================================
# Erlang A (M/M/N+M): callers hang up after an exponential patience
# =============================================================================

def _queue_state_probabilities(agents: int, load: float, mu: float, theta: float) -> list[float]:
    """Stationary probabilities of n calls in the system (in service + queue)
    for the birth-death chain with arrival rate lam = load * mu, service
    rate min(n, N) * mu and abandonment rate max(n - N, 0) * theta."""
    lam = load * mu
    weights = [1.0]
    weight, n = 1.0, 1
    while True:
        death = min(n, agents) * mu + max(n - agents, 0) * theta
        weight = weight * lam / death
        weights.append(weight)
        if n > agents and weight < QUEUE_MASS_CUTOFF * max(weights):
            break
        if n >= agents + MAX_QUEUE_STATES:
            break
        n += 1
    total = sum(weights)
    return [w / total for w in weights]


def _survives_and_answered_within(rates: list[float], theta: float, t: float) -> float:
    """P(V <= t and patience > V) where V = sum of independent Exp(rates)
    is the offered wait (stage i = i callers still ahead, rate rates[i])
    and the caller's own patience is Exp(theta).

    Computed by uniformization (Jensen): embed the stage chain in a Poisson
    clock of rate L = max(rate + theta), step the discrete chain, and weight
    step m by Poisson(m; L t). Every term is positive, so it is stable even
    when the stage rates are nearly equal (the Erlang C limit).
    """
    stages = len(rates)
    clock = max(r + theta for r in rates)
    if clock <= 0 or t <= 0:
        return 0.0
    alive = [0.0] * stages
    alive[stages - 1] = 1.0                    # start with all callers ahead
    answered_by_step = 0.0
    poisson, cumulative, m = math.exp(-clock * t), 0.0, 0
    total = 0.0
    while cumulative < 1.0 - UNIFORMIZATION_TAIL:
        total += poisson * answered_by_step
        cumulative += poisson
        # one step of the embedded discrete chain
        next_alive = [0.0] * stages
        for i in range(stages):
            mass = alive[i]
            if mass == 0.0:
                continue
            forward = mass * rates[i] / clock
            if i == 0:
                answered_by_step += forward
            else:
                next_alive[i - 1] += forward
            next_alive[i] += mass * (1.0 - (rates[i] + theta) / clock)
        alive = next_alive
        m += 1
        poisson *= clock * t / m
        if m > MAX_UNIFORMIZATION_STEPS:
            break
    return min(1.0, max(0.0, total))


def erlang_a(agents: int, load: float, aht_sec: float, patience_sec: float,
             target_sec: float) -> dict:
    """Erlang A (M/M/N+M) for `agents` servers, offered `load` erlangs, mean
    handle time `aht_sec` and mean caller patience `patience_sec`.

    Returns
        wait_prob      probability an arriving caller has to wait at all
        abandon_prob   probability an arriving caller hangs up before answer
        service_level  probability an arriving caller is answered within
                       target_sec (hang-ups count as not answered)

    A caller who arrives with j callers queued ahead reaches an agent after
    V_j = Exp(N mu + j theta) + Exp(N mu + (j-1) theta) + ... + Exp(N mu):
    each stage ends when the head of the queue is served (rate N mu) or one
    of the callers still ahead hangs up. Their own patience is Exp(theta).

    Edge cases:
        load <= 0        -> nobody waits, nobody abandons, service level 1
        agents <= 0      -> everyone waits and eventually hangs up
    """
    if load <= 0:
        return {"wait_prob": 0.0, "abandon_prob": 0.0, "service_level": 1.0}
    if agents <= 0:
        return {"wait_prob": 1.0, "abandon_prob": 1.0, "service_level": 0.0}
    if aht_sec <= 0 or patience_sec <= 0:
        raise ValueError(f"aht_sec and patience_sec must be > 0, got {aht_sec}, {patience_sec}")

    mu, theta = 1.0 / aht_sec, 1.0 / patience_sec
    pi = _queue_state_probabilities(agents, load, mu, theta)

    wait_prob = sum(pi[agents:])
    abandon_prob = 0.0
    answered_within = sum(pi[:agents])          # no wait: answered at once
    for ahead, p in enumerate(pi[agents:]):
        if ahead > MAX_QUEUE_AHEAD:
            abandon_prob += p                     # negligible tail, counted as lost
            continue
        rates = [agents * mu + i * theta for i in range(ahead + 1)]
        survive = 1.0
        for r in rates:
            survive *= r / (r + theta)            # E[e^{-theta V_j}]
        abandon_prob += p * (1.0 - survive)
        answered_within += p * _survives_and_answered_within(rates, theta, target_sec)

    return {
        "wait_prob": min(1.0, max(0.0, wait_prob)),
        "abandon_prob": min(1.0, max(0.0, abandon_prob)),
        "service_level": min(1.0, max(0.0, answered_within)),
    }
