import { ApplicationConfig, importProvidersFrom, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { JoyrideModule } from 'ngx-joyride';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    // withComponentInputBinding: el param de ruta `:ticker` se bindea directo
    // al input() `ticker` de OperarComponent (ver operar.component.ts) — así
    // /operar/{ticker} hidrata el componente sin pasar por ningún estado
    // intermedio ni servicio de navegación propio.
    provideRouter(routes, withComponentInputBinding()),
    // Requerido por ngx-joyride para poder inyectar JoyrideService (PoC en
    // el panel de arbitraje, ver arbitrage.component.ts).
    importProvidersFrom(JoyrideModule.forRoot()),
  ],
};
