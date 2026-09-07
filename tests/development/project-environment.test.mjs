import assert from "node:assert/strict";
import test from "node:test";
import {
  detectProjectConfiguration,
  inspectProjectEnvironment,
  parseProjectConfiguration,
  serializeProjectConfiguration,
} from "../../frontend/src/development/project-environment.js";

test("detects Vite projects and creates executable tasks", () => {
  const config = detectProjectConfiguration(new Map([
    ["package.json", JSON.stringify({ scripts: { dev: "vite", test: "vitest run" }, devDependencies: { vite: "1" } })],
    ["src/main.js", "console.log('ready')"],
  ]), { name: "Vite fixture" });
  assert.equal(config.project.framework, "vite");
  assert.equal(config.project.name, "Vite fixture");
  assert.ok(config.tasks.some((entry) => entry.id === "npm.dev"));
  assert.ok(config.tasks.some((entry) => entry.id === "npm.test"));
});

test("round trips project configuration without exposing secret values", () => {
  const source = `version = 1

[project]
name = "API"
root = "."
framework = "fastapi"

[packages]
apt = ["git"]
npm = []
pip = ["fastapi", "uvicorn"]

[env]
APP_MODE = "development"

[secrets]
DATABASE_URL = "vault:database-url"

[[tasks]]
id = "dev"
label = "Run API"
command = "uvicorn main:app"
cwd = "."
kind = "command"
background = true
problem_matcher = ""

[preview]
task = "dev"
path = "/"
auto_open = true

[permissions]
network = "ask"
package_install = "ask"
`;
  const config = parseProjectConfiguration(source);
  const restored = parseProjectConfiguration(serializeProjectConfiguration(config));
  assert.deepEqual(restored, config);
  assert.deepEqual(restored.secrets, { DATABASE_URL: "vault:database-url" });
  assert.equal(serializeProjectConfiguration(config).includes("postgres://"), false);
});

test("reports only missing dependencies", () => {
  const config = detectProjectConfiguration({
    "requirements.txt": "Flask==3.1\npytest>=8\n",
    "app.py": "from flask import Flask\napp = Flask(__name__)",
  });
  const result = inspectProjectEnvironment(config, { pip: ["Flask"] });
  assert.deepEqual(result.missing.pip, ["pytest"]);
  assert.equal(result.ready, false);
});

test("rejects project traversal and literal secrets", () => {
  assert.throws(() => parseProjectConfiguration(`version=1\n[project]\nroot="../outside"\nframework="static"`), /inside the project/);
  assert.throws(() => parseProjectConfiguration(`version=1\n[project]\nroot="."\nframework="static"\n[secrets]\nTOKEN="literal"`), /vault:name/);
});
