/*
 * ============================================================================
 * SET DE ICONOS
 * ============================================================================
 *
 * Portado de `components/ui/icons.tsx` de homesi-reporte-actividad, con los
 * mismos paths (Lucide, licencia ISC) y el mismo envoltorio, para que un icono
 * se vea idéntico en las dos apps.
 *
 * Están SÓLO los cuatro que esta app dibuja. El original tiene 36: copiarlos
 * todos dejaría 32 iconos muertos que igual habría que mantener sincronizados.
 * Si hace falta uno más, se transcribe de allá y no se inventa.
 *
 * No se instala `lucide-react`: es la misma decisión del repo hermano, y un
 * paquete completo en el bundle del cliente para cuatro iconos no se justifica.
 *
 * Todos heredan el color con `currentColor` -- el color se decide en el sitio
 * de uso, nunca acá.
 */

import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Lado del cuadrado del icono en px. Por defecto 16 (grilla 24 escalada). */
  size?: number;
}

/**
 * Envoltorio común: fija viewBox/stroke/linecap de Lucide para que todos se
 * vean como un set coherente y no como SVG sueltos de orígenes distintos.
 */
function Icon({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** lucide: upload — botón de subir. */
export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </Icon>
  );
}

/** lucide: file-spreadsheet — selector de archivo (.xlsx / .csv). */
export function FileSheetIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
      <path d="M8 13h2" />
      <path d="M14 13h2" />
      <path d="M8 17h2" />
      <path d="M14 17h2" />
    </Icon>
  );
}

/** lucide: triangle-alert — /no-access. */
export function AlertTriangleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

/** lucide: log-out — cerrar sesión, en el header. */
export function LogOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </Icon>
  );
}
