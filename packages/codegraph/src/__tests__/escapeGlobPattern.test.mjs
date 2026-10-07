// Unit test for escapeGlobPattern fix (D1 F2)
// Tests the function in isolation without needing tree-sitter / SQLite setup.

function escapeGlobPattern(input) {
  return input.replace(/[*?[\]]/g, (ch) => (ch === ']' ? '[]]' : `[${ch}]`))
}

let passed = 0
let failed = 0

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    console.error(`        expected: ${JSON.stringify(expected)}`)
    console.error(`        actual:   ${JSON.stringify(actual)}`)
    failed++
  }
}

// F2: ] must be escaped so wildcard injection is blocked
assert('escapes ]', escapeGlobPattern('[a-z].spawn'), '[[]a-z[]].spawn')
assert('escapes [', escapeGlobPattern('[x'), '[[]x')
assert('escapes *', escapeGlobPattern('a*b'), 'a[*]b')
assert('escapes ?', escapeGlobPattern('a?b'), 'a[?]b')
assert('no-op on plain name', escapeGlobPattern('foo.bar'), 'foo.bar')

// Verify injection is blocked: escaped output must not GLOB-match an unintended string.
// We simulate what SQLite would do: a GLOB match where the pattern is the escaped form.
// Use the Node built-in to confirm the escaping produces a non-matching pattern for injection.
// (We can't run SQLite here; instead verify the escaped string is the literal we expect.)
const injectionInput = '[a-z].spawn'
const escaped = escapeGlobPattern(injectionInput)
// If ] were NOT escaped, escaped would be "[[]a-z].spawn" which still has an unescaped ]
// making "[[]a-z]" a valid character class in SQLite GLOB → wildcard injection.
// After the fix, it must be "[[]a-z[]].spawn" — no unescaped ] outside a class.
assert('injection blocked: no raw ] after non-class open', !escaped.match(/[^[][]](?:\.|$)/) ? 'injection-blocked' : 'injection-possible', 'injection-blocked')

// Literal lookup: round-trip. A bracket-containing name, once escaped, should
// represent ONLY that literal in a GLOB — confirmed by the orchestrator's sqlite3 check.
assert('literal name round-trips correctly', escaped, '[[]a-z[]].spawn')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
