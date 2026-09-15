import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const serverPath = path.join(root, 'server.js');
let server = fs.readFileSync(serverPath, 'utf8');

if (!server.includes('installPasswordRecovery')) {
  const importAnchor = 'import { normalizeAuditEntityId } from "./lib/audit-entity.js";';
  if (!server.includes(importAnchor)) throw new Error('Password recovery backend: import anchor not found.');
  server = server.replace(importAnchor, importAnchor + '\nimport { installPasswordRecovery } from "./lib/password-recovery.js";');

  const routeAnchor = 'app.post("/api/login",';
  if (!server.includes(routeAnchor)) throw new Error('Password recovery backend: login route anchor not found.');
  server = server.replace(routeAnchor, 'await installPasswordRecovery({ app, pool, asyncRoute, auth, adminOnly, audit, sessionSecret });\n\n' + routeAnchor);
}

fs.writeFileSync(serverPath, server);
console.log('Backend de recuperação de senha conectado.');
