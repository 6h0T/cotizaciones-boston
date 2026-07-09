import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * flip-num — número con efecto "split-flap" (tablero Solari de aeropuerto).
 *
 * Recibe el string YA formateado y renderiza un span por carácter. Cuando un
 * carácter cambia, se bumpea su "generación": eso cambia la key del track del
 * @for, Angular recrea el span y la animación CSS de volteo corre sola en el
 * elemento nuevo — sin timers ni manejo manual de clases. Los caracteres se
 * alinean desde la DERECHA (en un número que crece o pierde un dígito, lo que
 * se corre es la izquierda), así solo aletean las fichas que realmente
 * cambian. El delay por posición da el efecto de onda del tablero real.
 */

interface FlapChar {
  key: string;   // posición-desde-la-derecha : generación
  ch: string;
  delay: string; // stagger de la onda (izquierda → derecha)
}

@Component({
  selector: 'app-flip-num',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (c of chars(); track c.key) {<span class="ch" [style.animation-delay]="c.delay">{{ c.ch }}</span>}`,
  styles: [`
    :host {
      display: inline-flex;
      justify-content: flex-end;
      perspective: 160px;
      white-space: pre;
    }
    .ch {
      display: inline-block;
      transform-origin: 50% 50%;
      backface-visibility: hidden;
      animation: flap .32s cubic-bezier(.3, .7, .4, 1) backwards;
    }
    @keyframes flap {
      0%   { transform: rotateX(-88deg); opacity: .35; }
      55%  { transform: rotateX(14deg); opacity: 1; }
      100% { transform: rotateX(0deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .ch { animation: none; }
    }
  `],
})
export class FlipNumComponent {
  // String ya formateado (ej: "1.234,56", "+0,45%", "—").
  v = input.required<string>();

  // Estado interno de generaciones por posición-desde-la-derecha. Mutarlo
  // dentro del computed es seguro: corre exactamente una vez por cambio de
  // input (memoizado) y no lee otras señales.
  private prev: string[] = [];
  private gens: number[] = [];

  chars = computed<FlapChar[]>(() => {
    const chs = [...(this.v() ?? '')];
    const n = chs.length;
    const out: FlapChar[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = n - 1 - i; // posición desde la derecha
      if (this.prev[k] !== chs[i]) this.gens[k] = (this.gens[k] ?? 0) + 1;
      out[i] = {
        key: `${k}:${this.gens[k]}`,
        ch: chs[i],
        delay: `${i * 22}ms`,
      };
    }
    this.prev = chs.slice().reverse(); // indexado por posición-desde-la-derecha
    return out;
  });
}
