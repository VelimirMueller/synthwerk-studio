<script setup lang="ts">
import { SwPill } from '@synthwerk/ui-vue'
import { type Alert, formatSince, safeTraceUrl, sortAlerts } from '~/utils/health'

// Active alerts of pulse (synthwerk#57). The trace link shows only for an http(s) URL;
// pulse sends it to operators only.
const props = defineProps<{ alerts: Alert[]; now: number }>()
const sorted = computed(() =>
  sortAlerts(props.alerts).map((a) => ({ ...a, link: safeTraceUrl(a.trace_url) }))
)
</script>

<template>
  <ul v-if="sorted.length > 0" class="alerts">
    <li
      v-for="a in sorted"
      :key="a.id"
      class="alert"
      :class="a.severity === 'critical' ? 'alert--critical' : 'alert--warning'"
    >
      <SwPill :kind="a.severity === 'critical' ? 'solid' : 'accent'">{{ a.severity }}</SwPill>
      <div class="alert__body">
        <p class="alert__summary">{{ a.summary }}</p>
        <p class="alert__meta">
          <span class="mono">{{ a.subject }}</span>
          ·
          <time :datetime="a.since" :title="new Date(a.since).toLocaleString('en-GB')">
            since {{ formatSince(a.since, now) }}
          </time>
        </p>
      </div>
      <a v-if="a.link" class="alert__trace" :href="a.link" target="_blank" rel="noopener noreferrer"
        >Open trace</a
      >
    </li>
  </ul>
  <p v-else class="muted">No active alerts.</p>
</template>

<style scoped>
.alerts {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.5rem;
}

.alert {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  border: 1px solid var(--card-border);
  border-left-width: 3px;
  border-radius: var(--radius-md);
  background: var(--card-bg);
  padding: 0.75rem 1rem;
}

.alert--critical {
  border-left-color: var(--danger);
}

.alert__body {
  flex: 1 1 16rem;
  display: grid;
  gap: 0.125rem;
}

.alert__summary {
  margin: 0;
}

.alert__meta {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}

.mono {
  font-family: var(--font-mono);
}

.alert__trace {
  font-size: var(--text-sm);
  white-space: nowrap;
}
</style>
