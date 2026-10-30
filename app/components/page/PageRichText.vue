<script setup lang="ts">
import { safeHref } from '@synthwerk/ui-vue'
// Renders the Markdown subset of a section text as nodes (shared/sections.ts parseRichText).
// No v-html: every text goes through Vue text interpolation. Links pass safeHref() too.
import { parseRichText } from '#shared/sections'

const props = defineProps<{ text: string }>()
const blocks = computed(() => parseRichText(props.text))
</script>

<template>
  <template v-for="(block, b) in blocks" :key="b">
    <p v-if="block.type === 'p'" class="rich__p">
      <template v-for="(node, n) in block.children" :key="n">
        <br v-if="node.type === 'br'">
        <strong v-else-if="node.type === 'strong'">{{ node.text }}</strong>
        <em v-else-if="node.type === 'em'">{{ node.text }}</em>
        <a v-else-if="node.type === 'link'" :href="safeHref(node.href)">{{ node.text }}</a>
        <template v-else>{{ node.text }}</template>
      </template>
    </p>
    <ul v-else class="rich__ul">
      <li v-for="(item, i) in block.items" :key="i">
        <template v-for="(node, n) in item" :key="n">
          <strong v-if="node.type === 'strong'">{{ node.text }}</strong>
          <em v-else-if="node.type === 'em'">{{ node.text }}</em>
          <a v-else-if="node.type === 'link'" :href="safeHref(node.href)">{{ node.text }}</a>
          <template v-else-if="node.type === 'text'">{{ node.text }}</template>
        </template>
      </li>
    </ul>
  </template>
</template>
