function normalizeFiles(filesInput) {
  return filesInput instanceof Map ? filesInput : new Map(Object.entries(filesInput || {}));
}

function parsePackageJson(files) {
  try {
    return JSON.parse(String(files.get("package.json") || "{}"));
  } catch {
    return {};
  }
}

export function discoverTestSuites(filesInput) {
  const files = normalizeFiles(filesInput);
  const paths = [...files.keys()];
  const pkg = parsePackageJson(files);
  const suites = [];
  const add = (suite) => {
    if (!suites.some((entry) => entry.id === suite.id)) suites.push(suite);
  };

  if (paths.some((path) => /(^|\/)test_.*\.py$|(^|\/)tests\/.*\.py$/.test(path))) {
    add({ id: "python.pytest", label: "pytest", framework: "pytest", command: "python -m pytest -q", kind: "test" });
  }
  if (paths.some((path) => /(^|\/)test.*\.py$/.test(path))) {
    add({ id: "python.unittest", label: "Python unittest", framework: "unittest", command: "python -m unittest discover -v", kind: "test" });
  }
  if (paths.includes("manage.py")) {
    add({ id: "django.test", label: "Django tests", framework: "django", command: "python manage.py test", kind: "test" });
  }
  if (typeof pkg.scripts?.test === "string") {
    add({ id: "npm.test", label: "npm test", framework: "npm", command: "npm test", kind: "test" });
  }
  if (paths.includes("phpunit.xml") || paths.includes("phpunit.xml.dist") || paths.some((path) => /(^|\/)tests\/.*Test\.php$/.test(path))) {
    add({ id: "php.test", label: "PHP tests", framework: "php", command: "phpunit", kind: "test" });
  }
  return suites;
}

function locationFromLine(line) {
  const python = line.match(/([^\s:]+\.py):(\d+)(?::(\d+))?/);
  if (python) return { path: python[1], line: Number(python[2]), column: Number(python[3] || 1) };
  const javascript = line.match(/([^\s()]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+)/);
  if (javascript) return { path: javascript[1], line: Number(javascript[2]), column: Number(javascript[3]) };
  const php = line.match(/([^\s:]+\.php)(?::| on line )(\d+)/);
  if (php) return { path: php[1], line: Number(php[2]), column: 1 };
  return null;
}

export function parseTestOutput(framework, output, exitCode = 0) {
  const text = String(output || "");
  const lines = text.split(/\r?\n/);
  const cases = [];
  for (const line of lines) {
    let match;
    if (["pytest", "unittest", "django"].includes(framework)) {
      match = line.match(/^(.+?)\s+\.\.\.\s+(ok|FAIL|ERROR|skipped)/i)
        || line.match(/^(.+?)(?:\s+)(PASSED|FAILED|SKIPPED|ERROR)(?:\s|$)/i);
    } else if (framework === "npm") {
      const passed = line.match(/^\s*[✓✔]\s+(.+)$/);
      const failed = line.match(/^\s*[×✕✖]\s+(.+)$/);
      if (passed) match = [passed[0], passed[1], "passed"];
      else if (failed) match = [failed[0], failed[1], "failed"];
    } else if (framework === "php") {
      match = line.match(/^(?:PASS|FAIL|ERROR)\s+(.+)$/i);
    }
    if (!match) continue;
    const statusText = String(match[2] || line[0] || "").toLowerCase();
    const status = /fail|error|×|✕|✖/.test(statusText) ? "failed" : /skip/.test(statusText) ? "skipped" : "passed";
    cases.push({ name: String(match[1] || "test").trim(), status, location: locationFromLine(line) });
  }
  const failures = lines
    .map((line) => ({ line, location: locationFromLine(line) }))
    .filter((entry) => entry.location && /fail|error|traceback|assert/i.test(entry.line))
    .slice(0, 100);
  const unittestSummary = ["pytest", "unittest", "django"].includes(framework)
    ? text.match(/\bRan\s+(\d+)\s+tests?\b/i)
    : null;
  const reportedTotal = unittestSummary ? Number(unittestSummary[1]) : cases.length;
  const parsedPassed = cases.filter((entry) => entry.status === "passed").length;
  const parsedFailed = cases.filter((entry) => entry.status === "failed").length;
  const parsedSkipped = cases.filter((entry) => entry.status === "skipped").length;
  const aggregateOnly = reportedTotal > 0 && cases.length === 0;
  return {
    status: Number(exitCode) === 0 ? "passed" : "failed",
    exit_code: Number(exitCode),
    cases,
    total: reportedTotal,
    passed: aggregateOnly && Number(exitCode) === 0 ? reportedTotal : parsedPassed,
    failed: parsedFailed,
    skipped: parsedSkipped,
    failures,
  };
}

export class EdgeTermTestController extends EventTarget {
  constructor({ processHost }) {
    super();
    this.processHost = processHost;
    this.runs = new Map();
  }

  async run(suite, { cwd = "/home/user", env = {} } = {}) {
    const startedAt = performance.now();
    const run = {
      id: crypto.randomUUID(),
      suite: { ...suite },
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      process_id: "",
      result: null,
    };
    this.runs.set(run.id, run);
    this.dispatchEvent(new CustomEvent("test.started", { detail: { ...run } }));
    const process = await this.processHost.start({ command: suite.command, cwd, env, foreground: true, pty: false });
    run.process_id = process.id;
    const completed = await this.processHost.wait(process.id);
    const output = await this.processHost.output(process.id, { max_chars: 1_000_000 });
    const combinedOutput = `${output.stdout || ""}\n${output.stderr || ""}`.trim();
    run.result = {
      ...parseTestOutput(suite.framework, combinedOutput, completed.exit_code),
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      output: combinedOutput.slice(-100_000),
      truncated: combinedOutput.length > 100_000,
    };
    run.status = run.result.status;
    run.finished_at = new Date().toISOString();
    this.dispatchEvent(new CustomEvent("test.completed", { detail: { ...run } }));
    return { ...run };
  }

  async cancel(runId) {
    const run = this.runs.get(String(runId || ""));
    if (!run || run.status !== "running") return { cancelled: false };
    await this.processHost.signal(run.process_id, "SIGINT");
    run.status = "cancelled";
    run.finished_at = new Date().toISOString();
    return { cancelled: true, run: { ...run } };
  }
}
