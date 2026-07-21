import { Routes } from '@angular/router';
import { OperarComponent } from './operar.component';

// Rutas de Operar. Un solo componente atiende Home y la pantalla de orden
// (gráfico + Puntas + formulario de Orden, ver operar.component.ts) — el
// :ticker de la URL hidrata directo esa pantalla vía withComponentInputBinding
// (app.config.ts): sin vistas intermedias, sin servicio de navegación propio.
// ?tipo=venta (opcional, mismo mecanismo de input binding) abre el formulario
// en modo venta en vez de compra (ver Cartera → venderDesdeCartera).
export const routes: Routes = [
  { path: 'operar/:ticker', component: OperarComponent },
  { path: 'operar', component: OperarComponent },
  { path: '', redirectTo: 'operar', pathMatch: 'full' },
  { path: '**', redirectTo: 'operar' },
];
