<script setup lang="ts">
import { safeHref } from '@synthwerk/ui-vue'
// A call-to-action link that looks like SwButton. SwButton renders a <button> only, so the link
// takes its classes. The href passes safeHref() of @synthwerk/ui-vue on top of the server check.
import type { Link } from '#shared/sections'

const props = withDefaults(defineProps<{ link: Link; kind?: 'primary' | 'secondary' }>(), {
  kind: 'primary'
})
const href = computed(() => safeHref(props.link.href))
</script>

<template>
  <a
    v-if="href"
    :href="href"
    :class="['sw-button', `sw-button--${kind}`, 'sw-button--md', 'page-link']"
  >
    {{ link.label }}
  </a>
</template>
