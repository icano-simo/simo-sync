import type { Metadata } from 'next';
import { Inter, Barlow } from 'next/font/google';
import './globals.css';
import AppHeader from '@/components/layout/AppHeader';

/*
 * Shell de la app, replicado de homesi-reporte-actividad:
 *  - Header sticky arriba + canvas debajo. No hay sidebar.
 *  - Inter (body y tablas de datos) y Barlow (section headers del Brand Book),
 *    ambas expuestas como CSS custom properties para que las hojas de estilo
 *    las consuman vía --font-body / --font-display (tokens.css) en vez de
 *    nombrar la familia a mano en cada regla.
 *  - El ícono de la pestaña es `app/icon.png` (el mark coral del Brand Book,
 *    256x256). Es la convención de archivo de esta versión de Next: se detecta
 *    por ubicación y nombre, no se declara en `metadata`.
 *
 * `LayoutProps<'/'>` en vez del `{ children: React.ReactNode }` del repo
 * hermano: es el helper tipado que genera esta versión de Next (`next typegen`)
 * y ya era lo que usaba este archivo. Misma semántica, tipado más estricto.
 */

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-inter',
  display: 'swap',
});

const barlow = Barlow({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-barlow',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'HOMESÍ — Data Uploads',
  description: 'Carga de archivos de fuentes externas.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${barlow.variable}`}>
      <body>
        <div className="app">
          <AppHeader />
          <main className="hub-canvas">{children}</main>
        </div>
      </body>
    </html>
  );
}
