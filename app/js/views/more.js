// "Meer"-menu op de telefoon.
import { html, setHTML } from '../ui.js';
import { NAV } from '../app.js';

export async function render(el) {
  setHTML(el, html`<h1>Meer</h1><div class="card"><ul class="items">
    ${NAV.map((n) => html`<li><a class="item" href="#/${n.id}" style="text-decoration:none;color:inherit">
      <span style="font-size:1.4rem;width:2rem;text-align:center">${n.icon}</span><span class="grow name">${n.label}</span><span class="muted">›</span></a></li>`)}
  </ul></div>`);
}
