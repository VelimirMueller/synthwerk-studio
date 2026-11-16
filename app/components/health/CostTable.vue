<script setup lang="ts">
import { formatNumber } from '~/composables/useHealthView'
import { type AiCost, formatCost } from '~/utils/health'

// AI cost per UTC day (synthwerk#57), oldest first, from pulse.
defineProps<{ cost: AiCost }>()
</script>

<template>
  <div class="wrap">
    <table class="cost">
      <caption class="sr-only">
        AI cost per day
      </caption>
      <thead>
        <tr>
          <th scope="col">Day (UTC)</th>
          <th scope="col">Cost</th>
          <th scope="col">Answers</th>
          <th scope="col">Tokens in / out</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in cost.days" :key="d.date">
          <th scope="row">{{ d.date }}</th>
          <td>
            {{ formatCost(d.cost, cost.currency) }}
            <span v-if="d.unpriced_answers > 0" class="note"
              >+ {{ d.unpriced_answers }} unpriced</span
            >
          </td>
          <td>{{ formatNumber(d.answers) }}</td>
          <td>{{ formatNumber(d.input_tokens) }} / {{ formatNumber(d.output_tokens) }}</td>
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

.cost {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.cost th,
.cost td {
  padding: 0.625rem 1rem;
  text-align: right;
  border-bottom: 1px solid var(--border-subtle);
  white-space: nowrap;
}

.cost thead th {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--fg-muted);
}

.cost th:first-child {
  text-align: left;
  font-family: var(--font-mono);
}

.cost tbody tr:last-child > * {
  border-bottom: 0;
}

.note {
  margin-left: 0.375rem;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
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
