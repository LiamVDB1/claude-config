#!/usr/bin/env node
'use strict';

const fs = require('fs');
let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const pages = input.tool_input?.pages;
const shouldStripPages = typeof pages !== 'undefined'
  && (typeof pages !== 'string' || pages.trim() === '');

if (shouldStripPages) {
  const updatedInput = Object.fromEntries(
    Object.entries(input.tool_input ?? {}).filter(([key]) => key !== 'pages')
  );

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput
    }
  }));
}
