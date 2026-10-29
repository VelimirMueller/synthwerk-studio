<script setup lang="ts">
import {
  formatMs,
  formatNumber,
  formatPercent,
  type PlatformMetrics
} from '~/composables/useHealthView'

defineProps<{ services: NonNullable<PlatformMetrics['services']> }>()
</script>

<template>
  <div class="wrap">
    <table class="services">
      <caption class="sr-only">
        Rate, errors and p95 per service
      </caption>
      <thead>
        <tr>
          <th scope="col">Service</th>
          <th scope="col">Requests / s</th>
          <th scope="col">Errors</th>
          <th scope="col">p95</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in services" :key="s.service">
          <th scope="row">{{ s.service }}</th>
          <td>{{ formatNumber(s.requests_per_second, 2) }}</td>
          <td :class="{ bad: s.error_ratio >= 0.05 }">{{ formatPercent(s.error_ratio) }}</td>
          <td>{{ formatMs(s.p95_ms) }}</td>
        </tr>
        <tr v-if="services.length === 0">
          <td colspan="4" class="empty">No traffic in the window.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.wrap {
  overflow-x: auto;
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  background: var(--card-bg);
}

.services {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.services th,
.services td {
  padding: 0.625rem 1rem;
  text-align: right;
  border-bottom: 1px solid var(--border-subtle);
  white-space: nowrap;
}

.services thead th {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--fg-muted);
}

.services th:first-child {
  text-align: left;
  font-family: var(--font-mono);
}

.services tbody tr:last-child > * {
  border-bottom: 0;
}

.bad {
  color: var(--danger);
}

.empty {
  text-align: left;
  color: var(--fg-muted);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
