import fs from 'node:fs';

const testUrl = new URL('./selftest-ifood-order-days.js', import.meta.url);
let source = fs.readFileSync(testUrl, 'utf8');

const oldFragment = `  getCourierAttendance: async () => ({ checked_out_at: null }), getSPDate: async () => today,\n`;
const newFragment = `  getCourierAttendance: async () => ({ checked_out_at: null }), getSPDate: async () => today,\n  getCurrentOperationalShift: () => ({ operational_date: today, shift_code: 'LUNCH', shift_label: 'Almoço' }),\n`;

if (source.includes(newFragment)) {
  console.log('PASS step3 legacy sandbox compatibility already applied');
  process.exit(0);
}

if (!source.includes(oldFragment)) {
  throw new Error('Step 3 compatibility patch target not found in selftest-ifood-order-days.js');
}

source = source.replace(oldFragment, newFragment);
fs.writeFileSync(testUrl, source, 'utf8');
console.log('PASS step3 legacy sandbox compatibility applied');
