import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../public/ui-actions.js', import.meta.url), 'utf8');
// Verify both sides of a declarative binding instead of asserting the old,
// executable onclick attribute. No application data is evaluated here.
export function hasUiAction(html, body, type = 'click') {
  for (const match of source.matchAll(/"(a[0-9a-f]+)": \{ count: \d+, run: function\(event,args\)\{ ([^\n]+) \} \}/g)) {
    if (match[2] === body && html.includes(`data-ui-${type}="${match[1]}"`)) return true;
  }
  return false;
}
