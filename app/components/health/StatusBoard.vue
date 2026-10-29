<script setup lang="ts">
import { SwStatusPill } from '@synthwerk/ui-vue'
import type { HealthTarget, TargetStatus } from '~/composables/useHealthView'

defineProps<{ targets: HealthTarget[] }>()

// Status pill colours: emerald only for ok (design-system.md: green is status).
const pill: Record<TargetStatus, 'live' | 'building' | 'blocked' | 'planned'> = {
  ok: 'live',
  degraded: 'building',
  down: 'blocked',
  unknown: 'planned'
}
const label: Record<TargetStatus, string> = {
  ok: 'OK',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown'
}

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    : '-'
</script>

<template>
  <ul class="board" aria-label="Live status per service">
    <li v-for="t in targets" :key="t.target" class="tile" :data-status="t.status">
      <div class="tile__head">
        <span class="tile__name">{{ t.target }}</span>
        <SwStatusPill :status="pill[t.status]">{{ label[t.status] }}</SwStatusPill>
      </div>
      <dl class="tile__facts">
        <dt>Since</dt>
        <dd>{{ time(t.since) }}</dd>
        <dt>Check</dt>
        <dd>{{ t.checked_at ? `${t.latency_ms} ms` : '-' }}</dd>
      </dl>
      <p v-if="t.checks.some((c) => c.status !== 'ok')" class="tile__checks">
        <span v-for="c in t.checks.filter((c) => c.status !== 'ok')" :key="c.name">
          {{ c.name }}: {{ c.status }}
        </span>
      </p>
    </li>
    <li v-if="targets.length === 0" class="tile tile--empty">No targets yet.</li>
  </ul>
</template>

<style scoped>
.board {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
  gap: 0.75rem;
}

.tile {
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  background: var(--card-bg);
  padding: 0.875rem 1rem;
  display: grid;
  gap: 0.625rem;
}

.tile[data-status="down"] {
  border-color: color-mix(in srgb, var(--danger) 50%, var(--card-border));
}

.tile__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.tile__name {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.tile__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 0.75rem;
  margin: 0;
  font-size: var(--text-sm);
}

.tile__facts dt {
  color: var(--fg-muted);
}

.tile__facts dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.tile__checks {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: var(--text-xs);
  color: var(--fg-muted);
}

.tile--empty {
  color: var(--fg-muted);
}
</style>
