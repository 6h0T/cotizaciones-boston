import { Routes } from '@angular/router';
import { OperarComponent } from './operar.component';

// Rutas de Operar. Un solo componente atiende Home y la pantalla de orden
// (gráfico + Puntas + formulario de Orden, ver operar.component.ts) — el
// :ticker de la URL hidrata directo esa pantalla vía withComponentInputBinding
// (app.config.ts): sin vistas intermedias, sin servicio de navegación propio.
// ?tipo=venta (opcional, mismo mecanismo de input binding) abre el formulario
// en modo venta en vez de compra (ver Cartera → venderDesdeCartera).
//
// Operar está OCULTO del nav (botón removido en app.html): la raíz ya NO
// redirige a /operar — cae en la ruta vacía sin componente y la app arranca
// en Arbitraje (view signal en app.ts). Las rutas /operar y /operar/:ticker
// siguen vivas como entrada manual/deep-link para probar la pantalla.
export const routes: Routes = [
  { path: 'operar/:ticker', component: OperarComponent },
  { path: 'operar', component: OperarComponent },
  { path: '', children: [] },
  { path: '**', redirectTo: '' },
];
