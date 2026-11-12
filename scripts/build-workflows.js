#!/usr/bin/env node
'use strict';

/**
 * scripts/build-workflows.js
 * Compiles src/*.js (CommonJS stripped) into the generated region of every
 * n8n Code node in workflows/*.json, keeping workflows 100% synced with src/.
 *
 * Usage: npm run build
 */

const fs = require('fs');
const path = require('path');
const {
  listWorkflowFiles,
  syncWorkflow,
  serializeWorkflow,
  compileCodeNode,
  isCodeNode
} = require('./lib/bundler');

function build() {
  let totalChanged = 0;
  for (const file of listWorkflowFiles()) {
    const original = fs.readFileSync(file, 'utf8');
    const workflow = JSON.parse(original);
    const { workflow: synced, changedNodes } = syncWorkflow(workflow);
    for (const node of synced.nodes) {
      if (isCodeNode(node)) compileCodeNode(node.parameters.jsCode, node.name);
    }
    const output = serializeWorkflow(synced);
    if (output !== original) {
      fs.writeFileSync(file, output);
    }
    totalChanged += changedNodes.length;
    const label = path.basename(file);
    console.log(changedNodes.length
      ? '\u2714 ' + label + ': updated ' + changedNodes.length + ' Code node(s): ' + changedNodes.join(', ')
      : '\u2714 ' + label + ': already in sync');
  }
  console.log('\nBuild complete. ' + totalChanged + ' Code node(s) updated.');
}

try {
  build();
} catch (error) {
  console.error('\u2716 Build failed: ' + error.message);
  process.exit(1);
}
