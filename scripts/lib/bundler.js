'use strict';

/**
 * scripts/lib/bundler.js
 * Shared logic for build-workflows.js, check-workflows.js and the tests.
 *
 * Every n8n Code node contains a generated region delimited by markers:
 *
 *   // ==== BEGIN GENERATED BUNDLE (modules: config, sanitizer) ... ====
 *   ...compiled src/ modules (CommonJS stripped)...
 *   // ==== END GENERATED BUNDLE ====
 *   ...hand-written node glue code...
 *
 * The marker lists the entry modules; dependencies are resolved
 * automatically from `require('./x')` statements and emitted in a stable
 * topological order. Only the region between the markers is rewritten.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const WORKFLOWS_DIR = path.join(REPO_ROOT, 'workflows');

const BUNDLE_BEGIN_PATTERN = /\/\/ ==== BEGIN GENERATED BUNDLE \(modules: ([a-z0-9, -]+)\)[^\n]*\n[\s\S]*?\/\/ ==== END GENERATED BUNDLE ====/;
const LOCAL_REQUIRE_PATTERN = /^\s*const\s+(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]\.\/([a-z0-9-]+)(?:\.js)?['"]\s*\);?\s*$/gm;

function listSourceModules(srcDir) {
  const dir = srcDir || SRC_DIR;
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();
}

function readModuleSource(name, srcDir) {
  const file = path.join(srcDir || SRC_DIR, name + '.js');
  if (!fs.existsSync(file)) throw new Error('Unknown source module: ' + name);
  return fs.readFileSync(file, 'utf8');
}

function findLocalDependencies(source) {
  const deps = [];
  let match;
  const pattern = new RegExp(LOCAL_REQUIRE_PATTERN.source, 'gm');
  while ((match = pattern.exec(source)) !== null) deps.push(match[1]);
  return deps;
}

/**
 * Remove 'use strict', local require() statements and the trailing
 * module.exports block so modules can be concatenated into one scope.
 */
function stripCommonJs(source, name) {
  const exportIndex = source.search(/^module\.exports\s*=/m);
  if (exportIndex === -1) throw new Error('Module ' + name + ' must end with a module.exports assignment.');
  const tail = source.slice(exportIndex);
  if (!/^module\.exports\s*=\s*\{[\s\S]*\};?\s*$/.test(tail)) {
    throw new Error('Module ' + name + ': module.exports must be the final statement.');
  }
  let body = source.slice(0, exportIndex);
  body = body.replace(/^\s*['"]use strict['"];?\s*$/m, '');
  body = body.replace(new RegExp(LOCAL_REQUIRE_PATTERN.source, 'gm'), '');
  if (/\brequire\s*\(/.test(body)) {
    throw new Error('Module ' + name + ' uses a non-local require(); src/ modules must stay dependency-free.');
  }
  return body.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Resolve entry modules + transitive local deps in dependency order.
 */
function resolveModuleOrder(entryModules, srcDir) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error('Circular dependency detected at module: ' + name);
    visiting.add(name);
    for (const dep of findLocalDependencies(readModuleSource(name, srcDir))) visit(dep);
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  }
  for (const name of entryModules.slice().sort()) visit(name);
  return ordered;
}

function parseModuleList(list) {
  return String(list).split(',').map((s) => s.trim()).filter(Boolean);
}

function renderBundle(entryModules, srcDir) {
  const entries = Array.from(new Set(entryModules)).sort();
  const order = resolveModuleOrder(entries, srcDir);
  const parts = [
    '// ==== BEGIN GENERATED BUNDLE (modules: ' + entries.join(', ') + ') \u2014 DO NOT EDIT; run `npm run build` ====',
    '// Source of truth: src/' + order.join('.js, src/') + '.js'
  ];
  for (const name of order) {
    parts.push('// ---- src/' + name + '.js ----');
    parts.push(stripCommonJs(readModuleSource(name, srcDir), name).trimEnd());
  }
  parts.push('// ==== END GENERATED BUNDLE ====');
  return parts.join('\n');
}

function getBundleEntryModules(jsCode) {
  const match = String(jsCode || '').match(BUNDLE_BEGIN_PATTERN);
  return match ? parseModuleList(match[1]) : null;
}

function syncCode(jsCode, srcDir) {
  const match = String(jsCode).match(BUNDLE_BEGIN_PATTERN);
  if (!match) throw new Error('Code node is missing the GENERATED BUNDLE markers.');
  const bundle = renderBundle(parseModuleList(match[1]), srcDir);
  return String(jsCode).replace(BUNDLE_BEGIN_PATTERN, () => bundle);
}

function isCodeNode(node) {
  return node && node.type === 'n8n-nodes-base.code';
}

/**
 * Return a synced deep copy of the workflow plus names of changed nodes.
 */
function syncWorkflow(workflow, srcDir) {
  const copy = JSON.parse(JSON.stringify(workflow));
  const changedNodes = [];
  for (const node of copy.nodes || []) {
    if (!isCodeNode(node)) continue;
    const before = node.parameters.jsCode;
    const after = syncCode(before, srcDir);
    if (after !== before) {
      node.parameters.jsCode = after;
      changedNodes.push(node.name);
    }
  }
  return { workflow: copy, changedNodes };
}

function listWorkflowFiles(dir) {
  const d = dir || WORKFLOWS_DIR;
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(d, f));
}

function serializeWorkflow(workflow) {
  return JSON.stringify(workflow, null, 2) + '\n';
}

/**
 * Compile a Code node body the way n8n wraps it (async function body).
 * Throws on syntax errors, including duplicate top-level declarations.
 */
function compileCodeNode(jsCode, nodeName) {
  return new vm.Script('(async function () {\n' + jsCode + '\n})', { filename: (nodeName || 'code-node') + '.js' });
}

module.exports = {
  REPO_ROOT,
  SRC_DIR,
  WORKFLOWS_DIR,
  listSourceModules,
  readModuleSource,
  findLocalDependencies,
  stripCommonJs,
  resolveModuleOrder,
  renderBundle,
  getBundleEntryModules,
  syncCode,
  syncWorkflow,
  isCodeNode,
  listWorkflowFiles,
  serializeWorkflow,
  compileCodeNode
};
