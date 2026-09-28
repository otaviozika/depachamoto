import fs from 'node:fs';

const htmlPath = new URL('../public/index.html', import.meta.url);
const cssPath = new URL('../public/login-desktop.css', import.meta.url);
const css = fs.readFileSync(cssPath, 'utf8').trim();
if (/<\/style/i.test(css)) throw new Error('Login CSS cannot be embedded safely');

const start = '/* LOGIN APPROVED INLINE START */';
const end = '/* LOGIN APPROVED INLINE END */';
const html = fs.readFileSync(htmlPath, 'utf8');
const first = html.indexOf(start);
const last = html.indexOf(end, first + start.length);
if (first < 0 || last < 0) throw new Error('Approved login style markers are missing');

const next = html.slice(0, first + start.length) + '\n' + css + '\n' + html.slice(last);
if (next !== html) fs.writeFileSync(htmlPath, next);
console.log('Approved login styles embedded in the HTML.');
