<script setup lang="ts">
import { SwButton, SwCard, SwPill } from '@synthwerk/ui-vue'
import {
  applyChange,
  canViewHealth,
  formatBytes,
  formatMs,
  formatNumber,
  formatPercent,
  type HealthTarget,
  type MetricsAnswer,
  parseFrame,
  type StatusChange
} from '~/composables/useHealthView'

definePageMeta({ middleware: 'auth' })

// Health view (synthwerk#40). Status: one load, then the live stream. Numbers: every 15 s.
const METRICS_EVERY_MS = 15_000

const { session } = useAuthSession()
const allowed = computed(() => canViewHealth(session.value))

const targets = ref<HealthTarget[]>([])
const live = ref(false)
const metrics = ref<MetricsAnswer | null>(null)
const error = ref('')

const errorText: Record<string, string> = {
  forbidden: 'Only operators and the owners and admins of an org can open the health view.',
  pulse_unavailable: 'Pulse does not answer. The numbers come back when it is up.',
  pulse_not_configured: 'The health view is not set up on this studio.'
}

function readError(err: unknown): string {
  const code = (err as { data?: { data?: { code?: string } } })?.data?.data?.code ?? ''
  return Object.hasOwn(errorText, code) ? (errorText[code] ?? '') : 'The health data did not load.'
}

const request = useRequestFetch()
const { data: first, error: firstError } = await useAsyncData('health-status', () =>
  allowed.value ? request<{ targets: HealthTarget[] }>('/api/health/status') : Promise.resolve(null)
)
if (first.value) targets.value = first.value.targets
if (firstError.value) error.value = readError(firstError.value)

async function loadMetrics() {
  try {
    metrics.value = await $fetch<MetricsAnswer>('/api/health/metrics')
    error.value = ''
  } catch (err) {
    error.value = readError(err)
  }
}

let source: EventSource | undefined
let timer: ReturnType<typeof setInterval> | undefined
let mounted = false

/** Shows why the stream closed, from the same check the stream route makes. */
async function checkStatus() {
  try {
    const snap = await $fetch<{ targets: HealthTarget[] }>('/api/health/status')
    targets.value = snap.targets
  } catch (err) {
    error.value = readError(err)
  }
}

function openStream() {
  source?.close()
  source = new EventSource('/api/health/stream')
  source.addEventListener('open', () => {
    live.value = true
  })
  source.addEventListener('error', () => {
    live.value = false
    // CONNECTING: EventSource retries by itself (retry: 3000 from pulse). CLOSED: the
    // route refused (session ended, no role, pulse down). Check why, then retry later.
    if (source?.readyState === EventSource.CLOSED) {
      source = undefined
      void checkStatus()
      setTimeout(() => {
        if (!source && mounted) openStream()
      }, 15_000)
    }
  })
  source.addEventListener('snapshot', (ev) => {
    const snap = parseFrame<{ targets: HealthTarget[] }>((ev as MessageEvent<string>).data)
    if (snap) targets.value = snap.targets
  })
  source.addEventListener('status', (ev) => {
    const change = parseFrame<StatusChange>((ev as MessageEvent<string>).data)
    if (change) targets.value = applyChange(targets.value, change)
  })
}

onMounted(() => {
  mounted = true
  if (!allowed.value) return
  openStream()
  void loadMetrics()
  timer = setInterval(loadMetrics, METRICS_EVERY_MS)
})

onBeforeUnmount(() => {
  mounted = false
  source?.close()
  if (timer) clearInterval(timer)
})

const platform = computed(() =>
  metrics.value?.scope === 'platform' ? metrics.value.metrics : null
)
const ai = computed(() => metrics.value?.metrics.ai ?? null)
const windowMinutes = computed(() =>
  metrics.value ? Math.round(metrics.value.metrics.window_seconds / 60) : 5
)
const updated = computed(() =>
  metrics.value ? new Date(metrics.value.metrics.generated_at).toLocaleTimeString('en-GB') : ''
)
const down = computed(() => targets.value.filter((t) => t.status === 'down').length)

const ratio = (used: number, total: number) => (total > 0 ? used / total : null)
</script>

<template>
  <main class="page health">
    <header class="health__head">
      <div>
        <p class="eyebrow">Pulse</p>
        <h1>Health</h1>
      </div>
      <div v-if="allowed" class="health__meta">
        <SwPill :kind="live ? 'accent' : 'neutral'">{{ live ? 'Live' : 'Connecting' }}</SwPill>
        <SwPill v-if="metrics?.scope === 'org'">Your org only</SwPill>
        <SwPill v-else-if="metrics?.scope === 'platform'">All orgs</SwPill>
      </div>
    </header>

    <SwCard v-if="!allowed" eyebrow="No access" title="Health is for admins">
      <p class="muted">{{ errorText.forbidden }}</p>
      <template #footer>
        <SwButton kind="secondary" @click="navigateTo('/me')">Back to your profile</SwButton>
      </template>
    </SwCard>

    <template v-else>
      <p v-if="error" class="notice" role="alert">{{ error }}</p>

      <section class="health__section" aria-labelledby="h-status">
        <div class="section-head">
          <h2 id="h-status">Live status</h2>
          <span class="muted">{{ down === 0 ? 'Nothing is down.' : `${down} down` }}</span>
        </div>
        <HealthStatusBoard :targets="targets" />
      </section>

      <section class="health__section" aria-labelledby="h-ai">
        <div class="section-head">
          <h2 id="h-ai">AI</h2>
          <span class="muted"
            >Last {{ windowMinutes }} min{{ metrics?.scope === 'org' ? ', your org' : '' }}</span
          >
        </div>
        <dl class="stats">
          <HealthStatTile
            label="Tokens / min"
            :value="formatNumber(ai?.tokens_per_minute, 1)"
            :hint="ai ? `${ai.answers} answers` : 'No llm data'"
          />
          <HealthStatTile
            label="Model p95"
            :value="formatMs(ai?.latency_p95_ms)"
            :hint="ai && ai.failed > 0 ? `${ai.failed} failed` : 'Completed answers'"
          />
        </dl>
      </section>

      <template v-if="platform">
        <section class="health__section" aria-labelledby="h-services">
          <div class="section-head">
            <h2 id="h-services">Services</h2>
            <span class="muted">At the edge, last {{ windowMinutes }} min</span>
          </div>
          <HealthServiceTable v-if="platform.services" :services="platform.services" />
          <p v-else class="muted">No edge metrics. Set the Prometheus URL in pulse.</p>
        </section>

        <section class="health__section" aria-labelledby="h-infra">
          <div class="section-head">
            <h2 id="h-infra">Infrastructure</h2>
            <span class="muted">Updated {{ updated }}</span>
          </div>
          <dl class="stats">
            <HealthStatTile
              label="CPU"
              :value="formatPercent(platform.host?.cpu_ratio)"
              hint="Host, all cores"
            />
            <HealthStatTile
              label="Memory"
              :value="platform.host ? formatPercent(ratio(platform.host.memory_used_bytes, platform.host.memory_total_bytes)) : '-'"
              :hint="platform.host ? `${formatBytes(platform.host.memory_used_bytes)} of ${formatBytes(platform.host.memory_total_bytes)}` : 'Not readable'"
            />
            <HealthStatTile
              label="Disk"
              :value="platform.host ? formatPercent(ratio(platform.host.disk_used_bytes, platform.host.disk_total_bytes)) : '-'"
              :hint="platform.host ? `${formatBytes(platform.host.disk_used_bytes)} of ${formatBytes(platform.host.disk_total_bytes)}` : 'Not readable'"
            />
            <HealthStatTile
              label="DB connections"
              :value="formatNumber(platform.database?.connections)"
              :hint="platform.database ? `of ${platform.database.max_connections}` : 'Not readable'"
            />
            <HealthStatTile
              label="Pending messages"
              :value="formatNumber(platform.bus?.pending_messages)"
              :hint="platform.bus ? `${platform.bus.streams.length} streams` : 'Not readable'"
            />
          </dl>
        </section>
      </template>
    </template>
  </main>
</template>

<style scoped>
.health {
  max-width: 64rem;
}

.health__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
}

.health__meta {
  display: flex;
  gap: 0.5rem;
}

.eyebrow {
  margin: 0 0 0.25rem;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--accent-text);
}

.health__section {
  display: grid;
  gap: 0.75rem;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.section-head h2 {
  margin: 0;
  font-size: var(--text-lg);
}

.section-head .muted {
  font-size: var(--text-sm);
}

.stats {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 0.75rem;
}
</style>
