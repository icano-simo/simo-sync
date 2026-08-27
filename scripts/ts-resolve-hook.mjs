/**
 * Hook de resolución para poder ejecutar los scripts de `scripts/` con node
 * directamente, sin compilar y sin agregar dependencias.
 *
 * `lib/` importa sin extensión ('./sources'), que es lo que resuelve el bundler
 * de Next pero no el loader de ESM de node. El hook reintenta agregando '.ts'.
 *
 * Es sólo para los scripts: la app nunca pasa por acá.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return await next(`${specifier}.ts`, context);
    }
    throw err;
  }
}
