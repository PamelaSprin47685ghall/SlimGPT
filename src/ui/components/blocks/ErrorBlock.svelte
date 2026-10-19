<script>
  let { message = '' } = $props();
</script>

<div class="block-error" role="alert">{message || '消息生成失败'}</div>
