import bcrypt from "bcrypt";
import bcryptjs from "bcryptjs";

// Leave room in Node's shared worker pool for other work such as DNS lookups
// when the database pool has to open connections during a burst of logins.
const MAX_NATIVE_COMPARISONS = 2;
const waiting = [];
let active = 0;

export async function compareLoginPassword(password, hash) {
  // Preserve bcryptjs handling of legacy prefixes and lone UTF-16 surrogates.
  if (!hash.startsWith("$2b$") || !password.isWellFormed()) {
    return bcryptjs.compare(password, hash);
  }

  if (active === MAX_NATIVE_COMPARISONS) {
    await new Promise(resolve => waiting.push(resolve));
  } else {
    active++;
  }

  try {
    return await bcrypt.compare(password, hash);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
