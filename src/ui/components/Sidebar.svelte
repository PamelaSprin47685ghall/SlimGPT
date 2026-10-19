<script>
  import Page from 'framework7-svelte/components/page.svelte';
  import Navbar from 'framework7-svelte/components/navbar.svelte';
  import Subnavbar from 'framework7-svelte/components/subnavbar.svelte';
  import Searchbar from 'framework7-svelte/components/searchbar.svelte';
  import Block from 'framework7-svelte/components/block.svelte';
  import Button from 'framework7-svelte/components/button.svelte';
  import List from 'framework7-svelte/components/list.svelte';
  import ListItem from 'framework7-svelte/components/list-item.svelte';
  import { filterList } from '../state/logic.js';

  /** @type {{ list: {id:string,title:string,device?:boolean}[], currentId: string|null, running: Set<string>, freeMode?: boolean, onopen: (id: string|null) => void }} */
  let { list, currentId, running, freeMode = false, onopen } = $props();
  let query = $state('');
  const items = $derived(filterList(list, query));
</script>

<Page withSubnavbar class="sidebar">
  <Navbar title="对话">
    <Subnavbar inner={false}>
      <Searchbar
        customSearch
        disableButton={false}
        clearButton={false}
        placeholder="筛选标题"
        onSearchbarSearch={(_bar, value) => (query = value)}
        onSearchbarClear={() => (query = '')}
      />
    </Subnavbar>
  </Navbar>
  <Block class="new-chat-block">
    <Button fill class="new-chat" active={currentId === null} onClick={() => onopen(null)}>＋ 新对话</Button>
  </Block>
  {#if items.length}
    <List noChevron class="conv-list">
      {#each items as item (item.id)}
        <ListItem
          link
          class={item.id === currentId ? 'conv current' : 'conv'}
          title={item.title || '未命名对话'}
          after={running.has(item.id) ? '生成中' : item.device ? '本机' : undefined}
          onClick={() => onopen(item.id)}
        />
      {/each}
    </List>
  {:else}
    <Block class="sidebar-empty">{query ? '没有匹配的对话' : freeMode ? '暂无保存在本机的对话' : '暂无对话'}</Block>
  {/if}
  {#if freeMode}
    <Block class="sidebar-note">免费模式：对话仅保存在本机，清除扩展数据后无法找回。</Block>
  {/if}
</Page>
