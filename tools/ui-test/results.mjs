/**
 * Turn Playwright's JSON report into the ui_test result: pass/fail per test, the
 * failure message, and screenshot/trace paths. Specs run from a copy inside the
 * harness, so `from` -> `to` maps their paths back to the module checkout.
 */
const ANSI = /\x1b\[[0-9;]*m/g;
const MAX_ERROR = 2000;

export function summarize(report, { from, to } = {}) {
  const local = (s) => (s && from ? s.split(from).join(to) : s);
  const message = (e) => local((e?.message ?? String(e ?? "")).replace(ANSI, "")).slice(0, MAX_ERROR);
  const tests = [];
  const walk = (suite, titles) => {
    const here = suite.title && !suite.title.match(/\.(spec|test)\.(m?js|ts)$/) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const r = t.results?.at(-1) ?? {};
        const status = r.status ?? "skipped";
        tests.push({
          title: [...here, spec.title].join(" › "),
          file: `${to ? `${to}/` : ""}${spec.file}:${spec.line}`, // spec.file is relative to testDir
          status,
          durationMs: r.duration ?? 0,
          // errors[] holds the timeout line AND the step that caused it; r.error is only the first.
          ...(status !== "passed" && status !== "skipped"
            ? { error: (r.errors?.length ? r.errors : [r.error]).map(message).join("\n\n").slice(0, MAX_ERROR) } : {}),
          attachments: (r.attachments ?? []).filter((a) => a.path).map((a) => a.path),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  const count = (s) => tests.filter((t) => t.status === s).length;
  const errors = (report.errors ?? []).map(message);
  const failed = tests.filter((t) => !["passed", "skipped"].includes(t.status)).length;
  return {
    ok: tests.length > 0 && failed === 0 && errors.length === 0,
    passed: count("passed"), failed, skipped: count("skipped"),
    tests, errors,
  };
}
