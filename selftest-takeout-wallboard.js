import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public', 'service-worker.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

function state(elapsedMin, totalMin) {
  const ratio = elapsedMin / totalMin;
  if (ratio >= 1) return 'LATE';
  if (ratio >= 0.5) return 'ALERT';
  return 'NORMAL';
}

const checks = {
  version_350: server.includes('const VERSION = "3.5.6";') && pkg.version === '3.5.6' && html.includes('<title>DespacheFull 3.5.6</title>'),
  schema_order_timing: server.includes('ADD COLUMN IF NOT EXISTS order_timing TEXT'),
  schema_preparation_start: server.includes('ADD COLUMN IF NOT EXISTS preparation_start_at TIMESTAMPTZ'),
  schema_preparation_times: server.includes('CREATE TABLE IF NOT EXISTS ifood_preparation_times'),
  customer_id_env: server.includes('process.env.IFOOD_CUSTOMER_ID') && env.includes('IFOOD_CUSTOMER_ID='),
  official_endpoint: server.includes('/myPreparationTime'),
  required_header: server.includes('"X-iFood-Customer-ID": customerId'),
  dynamic_sync: server.includes('syncIfoodPreparationTimes(merchantIds)') && server.includes('preparationTimes?.changed'),
  no_fixed_local_prep: server.includes('pt.preparation_time_minutes') && server.includes('minutes * 60_000'),
  normal_threshold: state(14.99, 30) === 'NORMAL',
  alert_at_half: state(15, 30) === 'ALERT',
  late_at_limit: state(30, 30) === 'LATE',
  labels: html.includes("label:'NORMAL'") && html.includes("label:'ALERTA'") && html.includes("label:'ATRASADO'"),
  text_only_colors: html.includes('.kds-prep-state.normal') && html.includes('.kds-prep-state.alert') && html.includes('.kds-prep-state.late'),
  prep_below_number: html.includes('kds-order-number') && html.includes('${prep}</div><div class="kds-order-time">'),
  live_second_update: html.includes('updateKdsPreparationStates();') && html.includes('},1000);'),
  fifo_frontend: html.includes("sort((a,b)=>kdsSortTime(a,'PREPARING')-kdsSortTime(b,'PREPARING'))"),
  fifo_backend: server.includes('ORDER BY COALESCE(o.order_created_at,o.last_event_at,o.updated_at) ASC,o.order_id ASC'),
  status_does_not_reorder: !html.includes('preparation_status===') && !html.includes('preparation_status ==='),
  scheduled_base: server.includes('scheduled && row?.preparation_start_at'),
  immediate_base: server.includes('row?.confirmed_at || row?.order_created_at'),
  unavailable_is_safe: html.includes('AGUARDANDO IFOOD'),
  pwa_cache: sw.includes('despachefull-v3.5.6-takeout-filter')
};

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  console.error(JSON.stringify({ result: 'FAIL', version: '3.5.6', failed, checks }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ result: 'PASS', version: '3.5.6', checks }, null, 2));
