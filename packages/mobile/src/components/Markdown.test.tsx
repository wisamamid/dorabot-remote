import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { isSafeLinkHref } from '../lib/safe-link.js'
import { Markdown } from './Markdown.js'

describe('markdown links', () => {
  it('renders the dorabot-remote: scheme as plain text, never an anchor', () => {
    const { container } = render(<Markdown source="Tap [free pizza](dorabot-remote://ask?prompt=rm%20-rf) now" />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('free pizza')
    expect(container.innerHTML).not.toContain('dorabot-remote')
  })
  it('blocks other schemes and obfuscated variants, keeps https', () => {
    for (const bad of ['javascript:alert(1)', 'DORABOT-REMOTE://ask?prompt=x', 'dorabot-remote:ask', 'file:///etc/passwd']) {
      expect(isSafeLinkHref(bad)).toBe(false)
      const { container } = render(<Markdown source={`[x](${bad})`} />)
      expect(container.querySelector('a')).toBeNull()
    }
    const ok = render(<Markdown source="[docs](https://example.com/a) and https://example.org" />)
    expect(ok.container.querySelectorAll('a').length).toBe(2)
    expect(isSafeLinkHref('mailto:a@b.co')).toBe(true)
  })
})
