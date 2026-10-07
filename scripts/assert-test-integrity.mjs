import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { isBunTestFile, isNodeTestFile } from './test-discovery.mjs'

const [runner, rootArg] = process.argv.slice(2)

if (!['node', 'bun'].includes(runner) || !rootArg) {
  console.error('usage: node scripts/assert-test-integrity.mjs <node|bun> <test-root>')
  process.exit(2)
}

const root = path.resolve(rootArg)

function collectTestFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || (runner === 'bun' && entry.name.startsWith('.'))) continue
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(absolutePath))
      continue
    }
    if (!entry.isFile()) continue

    const relativePath = path.relative(root, absolutePath)
    if ((runner === 'node' ? isNodeTestFile(relativePath) : isBunTestFile(relativePath))) {
      files.push(absolutePath)
    }
  }
  return files
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return null
}

function scriptKind(filePath) {
  switch (path.extname(filePath)) {
    case '.js': return ts.ScriptKind.JS
    case '.jsx': return ts.ScriptKind.JSX
    case '.mjs': return ts.ScriptKind.JS
    case '.cjs': return ts.ScriptKind.JS
    case '.tsx': return ts.ScriptKind.TSX
    default: return ts.ScriptKind.TS
  }
}

const apiModule = runner === 'node' ? 'node:test' : 'bun:test'
const suppressedMembers = new Set(
  runner === 'bun'
    ? ['only', 'skip', 'todo', 'if', 'skipIf', 'todoIf']
    : ['only', 'skip', 'todo'],
)
const suppressedImports = new Set(runner === 'bun' ? ['xdescribe', 'xit', 'xtest'] : [])

function findSuppressions(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  )
  const findings = []
  const testApis = new Set(['test', 'it', 'describe', 'suite'])
  const testContexts = new Set()

  function addFinding(node, spelling) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    findings.push({
      file: path.relative(process.cwd(), filePath),
      line: line + 1,
      column: character + 1,
      spelling,
    })
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== apiModule
      || !statement.importClause) continue

    if (statement.importClause.name) testApis.add(statement.importClause.name.text)
    const bindings = statement.importClause.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (['test', 'it', 'describe', 'suite'].includes(importedName)) testApis.add(element.name.text)
    }
  }

  function isTestApiExpression(node) {
    if (ts.isIdentifier(node)) return testApis.has(node.text) || testContexts.has(node.text)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return isTestApiExpression(node.expression)
    }
    return false
  }

  function rememberContextParameters(call) {
    if (!isTestApiExpression(call.expression)) return
    for (const argument of call.arguments) {
      if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) continue
      for (const parameter of argument.parameters) {
        if (ts.isIdentifier(parameter.name)) testContexts.add(parameter.name.text)
      }
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === apiModule
      && node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        if (suppressedImports.has(importedName)) addFinding(element, importedName)
      }
    }

    if (ts.isPropertyAccessExpression(node)
      && isTestApiExpression(node.expression)
      && suppressedMembers.has(node.name.text)) {
      addFinding(node, `.${node.name.text}`)
    }

    if (ts.isElementAccessExpression(node)
      && isTestApiExpression(node.expression)
      && node.argumentExpression
      && ts.isStringLiteral(node.argumentExpression)
      && suppressedMembers.has(node.argumentExpression.text)) {
      addFinding(node, `[${JSON.stringify(node.argumentExpression.text)}]`)
    }

    if (ts.isCallExpression(node)) {
      rememberContextParameters(node)
      if (ts.isIdentifier(node.expression) && suppressedImports.has(node.expression.text)) {
        addFinding(node.expression, node.expression.text)
      }
      if (!isTestApiExpression(node.expression)) {
        ts.forEachChild(node, visit)
        return
      }
      for (const argument of node.arguments) {
        if (!ts.isObjectLiteralExpression(argument)) continue
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
          const name = propertyName(property.name)
          if (!name || !suppressedMembers.has(name)) continue
          if (ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword) continue
          addFinding(property, `{ ${name}: ... }`)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return findings
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`::error::Test root does not exist or is not a directory: ${root}`)
  process.exit(1)
}

const testFiles = collectTestFiles(root).sort()
if (testFiles.length === 0) {
  console.error(`::error::${runner} discovery found zero test files on disk — refusing a false-green run.`)
  process.exit(1)
}

const suppressions = testFiles.flatMap(findSuppressions)
if (suppressions.length > 0) {
  for (const finding of suppressions) {
    console.error(`::error file=${finding.file},line=${finding.line},col=${finding.column}::Test suppression is forbidden: ${finding.spelling}`)
  }
  console.error(`::error::${runner} test integrity failed: ${suppressions.length} skip/todo/only suppression site(s) found.`)
  process.exit(1)
}

process.stdout.write(`${testFiles.length}\n`)
