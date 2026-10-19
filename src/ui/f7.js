// Framework7 setup: lite core + only the components the UI uses.
import Framework7 from 'framework7/lite';
import Panel from 'framework7/components/panel';
import Popover from 'framework7/components/popover';
import Toast from 'framework7/components/toast';
import Searchbar from 'framework7/components/searchbar';
import Framework7Svelte from 'framework7-svelte/shared/plugin.js';
import { app } from 'framework7-svelte/shared/f7.js';
import 'framework7/css';
import 'framework7/components/panel/css';
import 'framework7/components/popover/css';
import 'framework7/components/toast/css';
import 'framework7/components/searchbar/css';
import 'framework7/components/preloader/css';

Framework7.use([Panel, Popover, Toast, Searchbar]);
Framework7.use(Framework7Svelte);

export const f7params = { name: 'SlimGPT', theme: 'auto', darkMode: 'auto' };

/** Short toast; silently skipped when Framework7 is not initialised (component tests). */
export function notify(text) {
  app.f7?.toast?.show({ text, closeTimeout: 1600, position: 'center' });
}

/** Close the conversation panel (no-op while it is docked on wide screens). */
export function closePanel() {
  app.f7?.panel?.close('left');
}
