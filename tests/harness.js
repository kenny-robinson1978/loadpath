// A ~60-line test harness: chainable expectations, async tests, results rendered to the page
// and exposed on window.__TEST_RESULTS__ for automation.

const tests = [];
export const test = (name, fn) => tests.push({ name, fn });

const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

export function expect(actual) {
  const fail = (msg) => { throw new Error(msg); };
  const api = {
    toBe: (exp) => (Object.is(actual, exp) ? api : fail(`expected ${fmt(actual)} to be ${fmt(exp)}`)),
    toContain: (s) => (String(actual).includes(s) ? api : fail(`expected ${fmt(actual)} to contain ${fmt(s)}`)),
    notToContain: (s) => (!String(actual).includes(s) ? api : fail(`expected ${fmt(actual)} not to contain ${fmt(s)}`)),
    toInclude: (x) => (actual.includes(x) ? api : fail(`expected ${fmt(actual)} to include ${fmt(x)}`)),
    notToInclude: (x) => (!actual.includes(x) ? api : fail(`expected ${fmt(actual)} not to include ${fmt(x)}`)),
    toBeGreaterThan: (n) => (actual > n ? api : fail(`expected ${actual} > ${n}`)),
    toBeLessThan: (n) => (actual < n ? api : fail(`expected ${actual} < ${n}`)),
  };
  return api;
}

export async function run() {
  const out = document.getElementById('results');
  const results = [];
  const t0 = performance.now();
  for (const t of tests) {
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
    } catch (err) {
      results.push({ name: t.name, ok: false, error: err.message });
    }
  }
  const passed = results.filter((r) => r.ok).length;
  window.__TEST_RESULTS__ = { passed, failed: results.length - passed, results };
  document.getElementById('summary').innerHTML =
    `<b class="${passed === results.length ? 'ok' : 'bad'}">${passed}/${results.length} passed</b> in ${Math.round(performance.now() - t0)} ms`;
  out.innerHTML = results.map((r) => `<li class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✕'} ${r.name}${r.ok ? '' : `<pre>${r.error.replace(/</g, '&lt;')}</pre>`}</li>`).join('');
}

/** |a - b| ≤ tol·max(1, |b|) */
export function near(a, b, tol = 1e-6, label = '') {
  if (!(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)))) throw new Error(`${label} expected ${a} ≈ ${b} (tol ${tol})`);
}
