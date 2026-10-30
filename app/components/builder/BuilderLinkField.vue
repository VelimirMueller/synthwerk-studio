<script setup lang="ts">
import { SwInput } from '@synthwerk/ui-vue'
// Edits a button link: label and target. With `optional` a checkbox turns the link on and off.
import type { Link } from '#shared/sections'
import { LIMITS } from '#shared/sections'

const props = defineProps<{ legend: string; idPrefix: string; optional?: boolean }>()
const model = defineModel<Link | null>({ required: true })

function toggle(on: boolean) {
  model.value = on ? { label: 'Learn more', href: '#' } : null
}
</script>

<template>
  <fieldset class="form">
    <legend>{{ legend }}</legend>
    <label v-if="props.optional" class="check">
      <input
        type="checkbox"
        :checked="model !== null"
        @change="toggle(($event.target as HTMLInputElement).checked)"
      >
      <span>Show this button</span>
    </label>
    <template v-if="model">
      <div class="field">
        <label :for="`${idPrefix}-label`">Button text</label>
        <SwInput :id="`${idPrefix}-label`" v-model="model.label" :maxlength="LIMITS.label" />
      </div>
      <div class="field">
        <label :for="`${idPrefix}-href`">Link</label>
        <SwInput
          :id="`${idPrefix}-href`"
          v-model="model.href"
          type="url"
          :maxlength="LIMITS.href"
        />
        <span class="muted hint">https://…, mailto:…, /path on the site or #anchor.</span>
      </div>
    </template>
  </fieldset>
</template>
