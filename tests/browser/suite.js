import { EdgeTermBridgeClient } from "/host-client.js";

const frame = document.querySelector("iframe");
const output = document.querySelector("#results");
const status = document.querySelector("#status");
const results = [];
let client;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const request = (method, params = {}) => client.request(method, params, { timeoutMs: 180_000 });
async function connect() {
  client?.close();
  client = new EdgeTermBridgeClient({ iframe: frame, targetOrigin: location.origin, timeoutMs: 180_000 });
  await client.connect();
  await request("runtime.status");
}
async function save() {
  const passed = results.filter((item) => item.passed).length;
  await fetch("/__test/results", { method: "POST", body: JSON.stringify({ timestamp: new Date().toISOString(), userAgent: navigator.userAgent, passed, failed: results.length - passed, results }) });
}
async function test(name, run) {
  const options = new URLSearchParams(location.search);
  if (options.get("focus") === "lifecycle" && !["Bridge connection", "Create isolated workspace", "APT package lifecycle"].includes(name)) return;
  if (options.has("production") && name === "Unavailable repository fails clearly") return;
  status.textContent = `Running: ${name}`;
  const started = performance.now();
  try {
    const evidence = await run();
    results.push({ name, passed: true, durationMs: Math.round(performance.now() - started), evidence });
    output.textContent += `PASS ${name}\n`;
  } catch (error) {
    results.push({ name, passed: false, durationMs: Math.round(performance.now() - started), error: error.message, code: error.code });
    output.textContent += `FAIL ${name}: ${error.message}\n`;
  }
  await save();
}
async function terminal(command, expected, cwd = "/home/user") {
  const result = await request("terminal.run", { command, cwd });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  check(result.exit_code === 0, `${command}: exit ${result.exit_code}\n${text}`);
  if (expected) check(expected.test(text), `${command}: unexpected output\n${text}`);
  return result;
}
async function write(path, content) { return request("fs.write", { path, content }); }
async function preview(framework, root, target, expected) {
  const app = await request("app.start", { framework, root, target });
  const response = await request("preview.request", { app_id: app.id, path: "/" });
  check(response.http_status === 200 && response.body.includes(expected), `${framework}: ${response.http_status}: ${response.body.slice(0, 1000)}`);
  await request("preview.open", { app_id: app.id });
  return { app, response };
}

document.querySelector("#run").addEventListener("click", async (event) => {
  event.target.disabled = true;
  results.length = 0;
  output.textContent = "";
  try {
    await test("Bridge connection", connect);
    await test("Create isolated workspace", () => request("workspace.create", { name: `Acceptance ${new Date().toISOString()}` }));
    await test("File write and terminal read", async () => {
      await write("/home/user/acceptance.txt", "persistent-workspace-ready\n");
      return terminal("cat acceptance.txt", /persistent-workspace-ready/);
    });
    await test("Python execution", () => terminal("python -c 'print(6 * 7)'", /42/));
    await test("Signed APT update", () => terminal("apt update", /packages.*up.to.date|Reading.*package|Repository verified/is));
    await test("APT Git candidate", () => terminal("apt-cache policy git", /Candidate:\s*2\.55/));
    await test("Install Git and PHP", () => terminal("apt install -y git php", /git.*php|Setting up|newest version/is));
    await test("Git executable", () => terminal("git --version", /git version 2\.55/));
    await test("Git repository transaction", async () => {
      await terminal("mkdir -p git-acceptance");
      const cwd = "/home/user/git-acceptance";
      await write(`${cwd}/hello.txt`, "git transaction\n");
      await terminal("git init", /Initialized/, cwd);
      await terminal("git config user.name 'EdgeTerm Acceptance'", null, cwd);
      await terminal("git config user.email 'acceptance@example.test'", null, cwd);
      await terminal("git add hello.txt", null, cwd);
      await terminal("git commit -m 'Acceptance fixture'", /Acceptance fixture/, cwd);
      return terminal("git diff --exit-code HEAD", null, cwd);
    });
    await test("PHP executable", () => terminal("php --version", /PHP 8\.4\.23/));
    await test("PHP program", () => terminal("php -r 'echo 6 * 7;'", /42/));
    await test("PHP HTTP preview", async () => {
      await write("/home/user/php-preview/index.php", "<?php echo 'PHP preview ready';");
      return preview("php", "/home/user/php-preview", "index.php", "PHP preview ready");
    });
    await test("Static HTTP preview", async () => {
      await write("/home/user/static-preview/index.html", "<!doctype html><h1>Static preview ready</h1>");
      return preview("static", "/home/user/static-preview", ".", "Static preview ready");
    });
    await test("Python Flask dependency", () => terminal("pip install flask", /flask|satisfied/i));
    await test("Flask HTTP preview", async () => {
      await write("/home/user/flask-preview/app.py", "from flask import Flask\napp = Flask(__name__)\n@app.route('/')\ndef index():\n    return 'Flask preview ready'\n");
      return preview("flask", "/home/user/flask-preview", "app:app", "Flask preview ready");
    });
    await test("Python FastAPI and Django dependencies", () => terminal("pip install fastapi django", /fastapi|django|satisfied/i));
    await test("FastAPI HTTP preview", async () => {
      await write("/home/user/fastapi-preview/main.py", "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/')\ndef index():\n    return {'message': 'FastAPI preview ready'}\n");
      return preview("fastapi", "/home/user/fastapi-preview", "main:app", "FastAPI preview ready");
    });
    await test("Django HTTP preview", async () => {
      await write("/home/user/django-preview/app.py", "from django.conf import settings\nsettings.configure(DEBUG=True, SECRET_KEY='test-only', ROOT_URLCONF=__name__, ALLOWED_HOSTS=['*'])\nimport django\ndjango.setup()\nfrom django.http import HttpResponse\nfrom django.urls import path\nfrom django.core.wsgi import get_wsgi_application\nurlpatterns = [path('', lambda request: HttpResponse('Django preview ready'))]\napplication = get_wsgi_application()\n");
      return preview("django", "/home/user/django-preview", "app:application", "Django preview ready");
    });
    await test("npm package install", async () => {
      await write("/home/user/npm-preview/package.json", JSON.stringify({ name: "acceptance-preview", version: "1.0.0", type: "module", scripts: { build: "vite build" }, dependencies: { react: "19.1.0", "react-dom": "19.1.0" } }));
      await write("/home/user/npm-preview/index.html", '<!doctype html><div id="root"></div><script type="module" src="/src.jsx"></script>');
      await write("/home/user/npm-preview/src.jsx", 'import React from "react"; import {createRoot} from "react-dom/client"; createRoot(document.getElementById("root")).render(React.createElement("h1",null,"React preview ready"));');
      return terminal("npm install", /installed|added|packages/i, "/home/user/npm-preview");
    });
    await test("npm frontend build", () => terminal("npm run build", /build|dist|built/i, "/home/user/npm-preview"));
    await test("Node JavaScript execution", () => terminal("node -e 'console.log(6 * 7)'", /42/));
    await test("npm HTTP preview", () => preview("static", "/home/user/npm-preview/dist", ".", "root"));
    await test("Rendered React preview", async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        for (const preview of frame.contentDocument.querySelectorAll("iframe")) {
          try {
            if (preview.contentDocument?.body?.innerText.includes("React preview ready")) return { text: "React preview ready" };
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("React did not render in the browser preview");
    });
    await test("Editor and file manager", async () => {
      const editor = await request("editor.open", { path: "/home/user/acceptance.txt" });
      const files = await request("ui.show", { view: "files" });
      return { editor, files };
    });
    await test("Unavailable repository fails clearly", async () => {
      await fetch("/__test/repository-mode", { method: "POST", body: JSON.stringify({ unavailable: true }) });
      try {
        const result = await request("terminal.run", { command: "apt update" });
        const text = `${result.stdout || ""}\n${result.stderr || ""}`;
        check(result.exit_code !== 0 && /repository.*unavailable|not configured/i.test(text), JSON.stringify(result));
        check(!/All packages are up to date/i.test(text), "Failed refresh reported success");
        return result;
      } catch (error) {
        if (!/repository.*unavailable|not configured/i.test(error.message)) throw error;
        return { error: error.message, code: error.code };
      } finally {
        await fetch("/__test/repository-mode", { method: "POST", body: JSON.stringify({ unavailable: false }) });
      }
    });
    await test("Workspace reload", async () => {
      const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
      frame.src = frame.src;
      await loaded;
      await connect();
      const file = await request("fs.read", { path: "/home/user/acceptance.txt" });
      check(file.content === "persistent-workspace-ready\n", "File did not persist across reload");
      return file;
    });
    await test("Installed Git survives reload", () => terminal("git --version", /git version 2\.55/));
    await test("Installed PHP survives reload", () => terminal("php --version", /PHP 8\.4\.23/));
    await test("APT package lifecycle", async () => {
      await terminal("apt install -y tree", /tree/);
      await terminal("tree --version", /tree/);
      await terminal("apt remove -y tree", /tree/);
      await terminal("test ! -f /usr/local/bin/tree");
      const removed = await request("terminal.run", { command: "dpkg-query -W -f '${Status}' tree" });
      check([0, 1].includes(removed.exit_code) && !/install ok installed/.test(removed.stdout || ""), "Package remains registered as installed");
      await terminal("apt install -y tree", /tree/);
      return terminal("tree --version", /tree/);
    });
    await request("ui.show", { view: "terminal" });
  } finally {
    const passed = results.filter((item) => item.passed).length;
    status.textContent = `Completed: ${passed} passed, ${results.length - passed} failed.`;
    await save();
    event.target.disabled = false;
  }
});
