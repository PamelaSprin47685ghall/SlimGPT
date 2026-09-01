<script>
  import { App, View } from 'framework7-svelte';
  import HomePage from './pages/HomePage.svelte';

  const f7params = {
    name: 'SlimGPT',
    id: 'local.slimgpt.app',
    theme: 'auto',
  };
</script>

<App {...f7params}>
  <View main>
    <HomePage />
  </View>
</App>
