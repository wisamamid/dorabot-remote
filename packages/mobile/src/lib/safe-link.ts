/** Links in agent output may only open as ordinary web / mail links. Never an app scheme such as dorabot-remote:. */
export function isSafeLinkHref(href: string): boolean {
  // Browsers ignore tabs / newlines / leading control chars and spaces inside a scheme.
  // eslint-disable-next-line no-control-regex
  const h = href.replace(/[\u0000- ]/g, '')
  return /^(https?:|mailto:)/i.test(h)
}
