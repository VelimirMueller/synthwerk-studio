<script setup lang="ts">
defineProps<{ label: string; value: string; hint?: string }>()
</script>

<template>
  <div class="stat">
    <dt class="stat__label">{{ label }}</dt>
    <dd class="stat__value">{{ value }}</dd>
    <dd v-if="hint" class="stat__hint">{{ hint }}</dd>
  </div>
</template>

<style scoped>
.stat {
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  background: var(--card-bg);
  padding: 0.875rem 1rem;
  display: grid;
  gap: 0.25rem;
  align-content: start;
}

.stat__label {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--fg-muted);
}

.stat__value {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-2xl);
  line-height: var(--text-2xl-line-height);
  font-variant-numeric: tabular-nums;
}

.stat__hint {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
</style>
