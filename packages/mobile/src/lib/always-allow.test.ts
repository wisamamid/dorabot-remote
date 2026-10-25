import { describe, expect, it } from 'vitest'
import { alwaysAllowOffer, ruleParams } from './always-allow.js'

describe('alwaysAllowOffer', () => {
  it('offers only the exact command for Bash', () => {
    const o = alwaysAllowOffer('Bash', { command: 'npm test' })!
    expect(o.label).toBe('Always allow this exact command')
    expect(o.spec).toEqual({ kind: 'exact', toolName: 'Bash', command: 'npm test' })
    expect(ruleParams(o.spec)).toEqual({ kind: 'exact', toolName: 'Bash', command: 'npm test', freshAuth: true })
  })
  it('offers the tool for ordinary tools', () => {
    const o = alwaysAllowOffer('WebFetch', { url: 'https://example.com' })!
    expect(o.label).toBe('Always allow WebFetch')
    expect(ruleParams(o.spec)).toEqual({ kind: 'tool', toolName: 'WebFetch', freshAuth: true })
  })
  it('offers nothing for risky inputs or free-form command tools', () => {
    expect(alwaysAllowOffer('Bash', { command: 'git push --force' })).toBeNull()
    expect(alwaysAllowOffer('Write', { file_path: '/Users/me/.zshrc', content: '' })).toBeNull()
    expect(alwaysAllowOffer('Write', { file_path: 'a.ts', content: '' }, { blockedPath: '/x' })).toBeNull()
    expect(alwaysAllowOffer('Shell', { command: 'ls' })).toBeNull()
  })
})
