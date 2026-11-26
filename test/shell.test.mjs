// Shell quoting and the per-request engine guard. Quoting is checked by letting /bin/sh parse the words;
// docker itself is never run.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineError, guardEngine } from '../lib/docker.mjs'
import { buildShellCommand, shellQuote } from '../lib/shell.mjs'

// The words /sh sees in `command`, NUL-separated so newlines inside a word survive.
// It runs in a throwaway directory with no usable PATH, so a quoting regression cannot touch the repository
// or run installed commands.
const shellWords = (command) => {
  const cwd = mkdtempSync(join(tmpdir(), 'containers-test-sh-'))
  try {
    return execFileSync('/bin/sh', ['-c', `set -- ${command}\nprintf '%s\\0' "$@"`], { encoding: 'utf8', cwd, env: { PATH: cwd } }).split('\0').slice(0, -1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

const HOSTILE = [
  '', 'plain', 'with space', "it's", "'", "''", "'; echo pwned; '", '$(echo pwned)', '`echo pwned`', '${HOME}',
  'a\nb', 'a;b&&c||d|e>f<g', '"quoted"', 'back\\slash\\', '*?[a]', '~', '#x', '-n', 'ñandú 🐳', "'\\''"
]

describe('shellQuote', () => {
  test('every hostile string stays a single literal word', () => {
    for (const text of HOSTILE) {
      assert.deepEqual(shellWords(shellQuote(text)), [text], JSON.stringify(text))
    }
  })

  test('stringifies non-string values', () => {
    assert.equal(shellQuote(42), "'42'")
  })
})

describe('buildShellCommand', () => {
  const ID = '0123456789ab'
  const BIN = '/Applications/My Apps/docker'
  const SHELL = 'command -v bash >/dev/null && exec bash || exec sh'

  test('targets the context explicitly', () => {
    assert.deepEqual(shellWords(buildShellCommand(BIN, 'colima', ID)), [BIN, '--context', 'colima', 'exec', '-it', ID, 'sh', '-c', SHELL])
  })

  test('omits --context when there is none', () => {
    for (const context of [null, undefined, '']) {
      assert.deepEqual(shellWords(buildShellCommand(BIN, context, ID)), [BIN, 'exec', '-it', ID, 'sh', '-c', SHELL])
    }
  })

  test('keeps a hostile binary path and context name literal', () => {
    const bin = "/tmp/x'; echo pwned; '/docker"
    const context = '$(echo pwned) --privileged'
    assert.deepEqual(shellWords(buildShellCommand(bin, context, ID)), [bin, '--context', context, 'exec', '-it', ID, 'sh', '-c', SHELL])
  })

  test('accepts a full 64-character id', () => {
    const id = 'f'.repeat(64)
    assert.equal(shellWords(buildShellCommand(BIN, null, id))[3], id)
  })

  test('throws on anything that is not a lowercase hex container id', () => {
    for (const id of ['', 'abc', 'my-container', '--privileged', `${ID};id`, `${ID} -u root`, `${ID}\n`, `\n${ID}`, ID.toUpperCase(), 'a'.repeat(65), undefined, null]) {
      assert.throws(() => buildShellCommand(BIN, null, id), /Invalid container id/, JSON.stringify(id))
    }
  })
})

describe('guardEngine', () => {
  test('allows a request whose engine is unchanged', () => {
    assert.equal(guardEngine('colima', 'colima', false), null)
    assert.equal(guardEngine(null, null, false), null)
  })

  test('allows calls made outside a request', () => {
    assert.equal(guardEngine(undefined, 'colima', false), null)
  })

  test('refuses when the engine changed during the request', () => {
    assert.match(guardEngine('colima', 'desktop-linux', false), /changed/)
    assert.match(guardEngine(null, 'colima', false), /changed/)
    assert.match(guardEngine('colima', null, false), /changed/)
  })

  test('refuses a missing engine, even for an unchanged or outside-request call', () => {
    assert.match(guardEngine('gone', 'gone', true), /"gone" no longer exists/)
    assert.match(guardEngine(undefined, 'gone', true), /no longer exists/)
    assert.match(guardEngine(undefined, null, true), /no longer exists/)
  })

  test('EngineError is a distinguishable Error', () => {
    assert.ok(new EngineError('x') instanceof Error)
    assert.equal(new Error('x') instanceof EngineError, false)
  })
})
