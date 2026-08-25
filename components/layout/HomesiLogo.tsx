import Image from 'next/image';

/*
 * ============================================================================
 * LOGO HOMESÍ — asset oficial del Brand Book
 * ============================================================================
 *
 * Copiado de homesi-reporte-actividad, junto con el PNG que consume.
 *
 * El lockup oficial YA incluye el ícono, el logotipo "HOMESÍ", el "Powered By"
 * y el logo de Supreme Lending, así que no hay ningún wordmark ni bloque
 * "powered by" en texto: serían una recreación de algo que la imagen ya trae, y
 * mantener las dos versiones garantiza que tarde o temprano dejen de coincidir.
 *
 * SE CONSUME EL .PNG Y NO EL .JPG: el JPG entregado tiene fondo BLANCO SÓLIDO
 * (JPEG no soporta canal alpha) y `.hub-header` usa `backdrop-filter`, que aísla
 * el stacking context -- cualquier truco de composición (mix-blend-mode) se
 * resuelve dentro del grupo y el rectángulo blanco queda visible igual. El PNG
 * con transparencia real no depende de eso. El derivado ya estaba hecho en el
 * repo hermano; acá se copia, no se regenera.
 *
 * Los .jpg originales quedan en `public/brand/` como fuente de verdad, sin que
 * los consuma nadie: `homesi-lockup.jpg` es el original de este PNG, y
 * `homesi-mark.jpg` es de donde salió `app/icon.png`. Si alguna vez hay que
 * regenerar un derivado, el punto de partida está en el repo y no en el mail de
 * alguien.
 */

/** Proporción real del archivo: 1089x187 (≈5.82:1). Alto de render en el header. */
const LOCKUP_HEIGHT = 32;
const LOCKUP_WIDTH = Math.round((1089 / 187) * LOCKUP_HEIGHT);

/**
 * Lockup de marca del header. `priority` porque está en el viewport inicial de
 * todas las rutas: sin eso Next lo carga en diferido y el header parpadea.
 */
export default function BrandLockup() {
  return (
    <Image
      className="hub-brand__logo"
      src="/brand/homesi-lockup.png"
      alt="HOMESÍ — Powered by Supreme Lending"
      width={LOCKUP_WIDTH}
      height={LOCKUP_HEIGHT}
      priority
    />
  );
}
