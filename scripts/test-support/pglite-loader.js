// Explicit opt-in test loader. It refuses non-local test configuration.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "pg" && context.parentURL?.endsWith("/server.js")) {
    if (process.env.APP_ENV !== "staging" || process.env.STAGING_SAFE_MODE !== "true" || !process.env.DATABASE_URL?.includes("127.0.0.1")) {
      throw new Error("The isolated PGlite test loader requires staging safe mode and a local placeholder URL.");
    }
    return { url: new URL("./pglite-pool.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
