import path from 'node:path'
import { isNodeTestFile } from './test-discovery.mjs'

// Node's built-in test summary reports tests, not files. This preload runs in
// each discovered test worker and emits one stable marker for the workflow's
// on-disk-versus-executed file-count guard. It never selects test files.
if (process.env['JERICO_REPORT_TEST_FILE'] === '1') {
  const entry = process.argv[1]
  if (entry && isNodeTestFile(entry)) {
    console.log(`# JERICO_TEST_FILE ${path.resolve(entry)}`)
  }
}
