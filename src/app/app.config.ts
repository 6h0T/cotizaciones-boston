import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    // withComponentInputBinding: el param de ruta `:ticker` se bindea directo
    // al input() `ticker` de OperarComponent (ver operar.component.ts) — así
    // /operar/{ticker} hidrata el componente sin pasar por ningún estado
    // intermedio ni servicio de navegación propio.
    provideRouter(routes, withComponentInputBinding()),
  ],
};
