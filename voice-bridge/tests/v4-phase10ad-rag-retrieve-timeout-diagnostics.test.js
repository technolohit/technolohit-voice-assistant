import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import {
  formatRagRetrievePreflightLines,
  runRagRetrievePreflight,
} from "../src/v4/rag-retrieve-preflight.js";
import {
  formatRagRetrieveDiagnosticsLines,
  runRagRetrieveDiagnostics,
  DEFAULT_DIAGNOSTIC_ATTEMPTS,
} from "../src/v4/rag-retrieve-diagnostics.js";
import { buildV4RagQuery } from "../src/v4/rag-orchestrator.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const finish = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result?.then) return result.finally(finish);
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
  }
}

function ragEnv(overrides = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_V4_LIVE_CANARY_ALLOWLIST: "bridge:",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    VOICE_RAG_API_URL: "http://127.0.0.1:8080",
    VOICE_RAG_TIMEOUT_MS: "700",
    ...overrides,
  };
}

const latencyBudgetRetrieveFn = async (_config, payload) => {
  const timeoutMs = Number(payload?.timeoutMs ?? 700);
  const simulatedLatency = timeoutMs >= 1200 ? 900 : 800;
  if (simulatedLatency > timeoutMs) {
    return { ok: false, reason: "timeout", latencyMs: simulatedLatency };
  }
  return {
    ok: true,
    hit: true,
    hitCount: 1,
    topScore: 0.88,
    status: 200,
    latencyMs: simulatedLatency,
    data: {
      answer_context: [{
        snippet: "Smart Website scoped knowledge.",
        score: 0.88,
        metadata: { product_id: "smart_website" },
      }],
    },
  };
};

const hitRetrieveFn = async () => ({
  ok: true,
  hit: true,
  hitCount: 1,
  topScore: 0.91,
  status: 200,
  latencyMs: 45,
  data: {
    answer_context: [{
      snippet: "Smart Website scoped knowledge.",
      score: 0.91,
      metadata: { product_id: "smart_website" },
    }],
  },
});

const missRetrieveFn = async () => ({
  ok: true,
  hit: false,
  hitCount: 0,
  status: 200,
  latencyMs: 120,
  data: { answer_context: [] },
});

const timeoutRetrieveFn = async (_config, payload) => ({
  ok: false,
  reason: "timeout",
  latencyMs: Number(payload?.timeoutMs ?? 700) + 5,
});

function flakyOnceThenHitRetrieveFn() {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, reason: "timeout", latencyMs: 706 };
    }
    return hitRetrieveFn();
  };
}

test("10AD: retrieve preflight distinguishes timeout from rag_miss", async () => {
  await withEnv(ragEnv(), async () => {
    const timeoutResult = await runRagRetrievePreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: timeoutRetrieveFn,
    });
    assert.equal(timeoutResult.ok, false);
    assert.equal(timeoutResult.fallback_reason, "rag_retrieve_timeout");
    assert.match(timeoutResult.failures.join(","), /rag_retrieve_timeout/);

    const missResult = await runRagRetrievePreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: missRetrieveFn,
    });
    assert.equal(missResult.ok, false);
    assert.equal(missResult.fallback_reason, "rag_miss");
    assert.match(missResult.failures.join(","), /rag_miss/);
    assert.doesNotMatch(missResult.failures.join(","), /rag_retrieve_timeout/);
  });
});

test("10AD: retrieve preflight remains strict when runtime timeout repeats", async () => {
  await withEnv(ragEnv({ VOICE_RAG_TIMEOUT_MS: "700" }), async () => {
    const result = await runRagRetrievePreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: latencyBudgetRetrieveFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.fallback_reason, "rag_retrieve_timeout");
    assert.equal(result.timeout_ms, 700);
  });
});

test("10AG: retrieve preflight tolerates one-off jitter and stops after first hit", async () => {
  await withEnv(ragEnv({ VOICE_RAG_TIMEOUT_MS: "700" }), async () => {
    const result = await runRagRetrievePreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: flakyOnceThenHitRetrieveFn(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempt_count, 2);
    assert.equal(result.success_count, 1);
    assert.equal(result.required_success_count, 1);
    assert.equal(result.timeout_count, 1);
    assert.equal(result.fallback_reason, null);
    assert.equal(result.hit, true);
  });
});

test("10AD: retrieve preflight fails on wrong_product_scope", async () => {
  await withEnv(ragEnv(), async () => {
    const result = await runRagRetrievePreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: hitRetrieveFn,
      buildV4RagQueryFn: (args) => {
        const payload = buildV4RagQuery(args);
        payload.context.product_scope = "voice_agent";
        return payload;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.fallback_reason, "wrong_product_scope");
    assert.match(result.failures.join(","), /wrong_product_scope/);
  });
});

test("10AD: diagnostics classifies latency_budget_issue when 700 times out and 1200 passes", async () => {
  await withEnv(ragEnv({ VOICE_RAG_TIMEOUT_MS: "700" }), async () => {
    const result = await runRagRetrieveDiagnostics(loadConfig(), {
      retrieveFn: latencyBudgetRetrieveFn,
      attemptCount: 3,
      timeoutBudgets: [700, 1200, 2000],
    });
    assert.equal(result.classification, "latency_budget_issue");
    assert.equal(result.ok, true);
    assert.equal(result.attempt_count, 3);
    assert.equal(result.hit_count, 0);
    const runtimeBudget = result.budgets.find((entry) => entry.timeout_ms === 700);
    const extendedBudget = result.budgets.find((entry) => entry.timeout_ms === 1200);
    assert.equal(runtimeBudget.hit_count, 0);
    assert.ok(extendedBudget.hit_count > 0);
  });
});

test("10AD: diagnostics summarizes multiple attempts safely", async () => {
  await withEnv(ragEnv(), async () => {
    const result = await runRagRetrieveDiagnostics(loadConfig(), {
      retrieveFn: latencyBudgetRetrieveFn,
      attemptCount: DEFAULT_DIAGNOSTIC_ATTEMPTS,
      timeoutBudgets: [700, 1200, 2000],
    });
    assert.equal(result.attempt_count, DEFAULT_DIAGNOSTIC_ATTEMPTS);
    assert.equal(result.product_scope, "smart_website");
    assert.equal(result.payload_tenant_id, "technolohit");
    assert.equal(result.payload_agent_id, "main_voice_sales");
    assert.ok(result.budgets.length === 3);
    for (const budget of result.budgets) {
      assert.equal(budget.attempt_count, DEFAULT_DIAGNOSTIC_ATTEMPTS);
    }
  });
});

test("10AD: diagnostics output contains no raw query transcript phone or email", async () => {
  await withEnv(ragEnv(), async () => {
    const output = formatRagRetrieveDiagnosticsLines(
      await runRagRetrieveDiagnostics(loadConfig(), {
        retrieveFn: timeoutRetrieveFn,
        attemptCount: 2,
        timeoutBudgets: [700, 1200],
      }),
    );
    assert.match(output, /rag_retrieve_diagnostics=/);
    assert.match(output, /classification=/);
    assert.match(output, /latency_ms_p50=/);
    assert.doesNotMatch(output, /Was ist Smart Website/);
    assert.doesNotMatch(output, /@[\w.-]+\.\w+/);
    assert.doesNotMatch(output, /\+?\d{10,}/);
  });
});

test("10AD: preflight output contains no raw query", async () => {
  await withEnv(ragEnv(), async () => {
    const output = formatRagRetrievePreflightLines(
      await runRagRetrievePreflight(loadConfig(), {
        skipCanary: true,
        retrieveFn: timeoutRetrieveFn,
      }),
    );
    assert.match(output, /fallback_reason=rag_retrieve_timeout/);
    assert.match(output, /failures=rag_retrieve_timeout/);
    assert.match(output, /attempt_count=3/);
    assert.match(output, /success_count=0/);
    assert.doesNotMatch(output, /Was ist Smart Website/);
  });
});

test("10AD: v3/RAG-off defaults unchanged", () => {
  return withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_RAG_ENABLED: undefined,
      VOICE_RAG_SALES_ANSWERER_ENABLED: undefined,
      VOICE_RAG_RETRIEVE_DIAGNOSTIC_TIMEOUT_MS: undefined,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.v4?.runtimeVersion ?? "v3", "v3");
      assert.equal(config.rag.enabled, false);
      assert.equal(config.rag.salesAnswererEnabled, false);
      assert.equal(config.rag.retrieveDiagnosticTimeoutMs, null);
      assert.equal(config.rag.timeoutMs, 700);
    },
  );
});

test("10AD: optional diagnostic timeout env is exposed without changing live timeout", () => {
  return withEnv(
    {
      VOICE_RAG_TIMEOUT_MS: "700",
      VOICE_RAG_RETRIEVE_DIAGNOSTIC_TIMEOUT_MS: "1500",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.rag.timeoutMs, 700);
      assert.equal(config.rag.retrieveDiagnosticTimeoutMs, 1500);
    },
  );
});
