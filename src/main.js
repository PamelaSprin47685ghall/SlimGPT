import Framework7 from 'framework7/lite';
import Framework7Svelte from 'framework7-svelte';
import 'framework7/css';
import './theme.css';
import App from './App.svelte';
import { mount } from 'svelte';

Framework7.use(Framework7Svelte);

mount(App, {
  target: document.getElementById('app'),
});
