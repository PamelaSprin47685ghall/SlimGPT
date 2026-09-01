<script>
  import { onDestroy } from 'svelte';
  import { formatToolPayloadAsToml, highlightToml } from '../lib/tool-format.js';

  let { tool } = $props();
  let copied = $state(false);
  let copyTimer = null;

  const toml = $derived(formatToolPayloadAsToml(tool?.payload));
  const highlighted = $derived(highlightToml(toml));

  onDestroy(() => clearTimeout(copyTimer));

  async function copyToml() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(toml);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = toml;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; }, 1800);
    } catch {
      // Clipboard access may be unavailable in some WebExtension contexts.
    }
  }
</script>

<div class="tool-payload-block" data-tool-kind={tool?.kind || ''}>
  <div class="tool-code-header">
    <span class="tool-code-language">TOML</span>
    <span class="tool-code-name">{tool?.name || 'tool'}</span>
    <button type="button" class:copied class="tool-code-copy" onclick={copyToml}>
      {copied ? '已复制' : '复制 TOML'}
    </button>
  </div>
  <pre class="tool-toml-pre"><code class="hljs language-toml">{@html highlighted}</code></pre>
</div>
