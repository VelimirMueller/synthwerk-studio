<script setup lang="ts">
import { SwCard, SwDivider, SwPill } from '@synthwerk/ui-vue'
// One section of a builder page, mapped to @synthwerk/ui-vue components. The same component
// renders the editor preview and, later, the public site (synthwerk#45).
import type { Section } from '#shared/sections'

defineProps<{ section: Section }>()
</script>

<template>
  <section :class="['page-section', `page-section--${section.type}`]">
    <template v-if="section.type === 'hero'">
      <SwPill v-if="section.eyebrow" kind="accent">{{ section.eyebrow }}</SwPill>
      <h1 class="page-section__hero-title">{{ section.title }}</h1>
      <PageRichText :text="section.body" />
      <div v-if="section.primary || section.secondary" class="page-section__actions">
        <PageLink v-if="section.primary" :link="section.primary" />
        <PageLink v-if="section.secondary" :link="section.secondary" kind="secondary" />
      </div>
    </template>

    <template v-else-if="section.type === 'proof'">
      <h2 v-if="section.title">{{ section.title }}</h2>
      <dl class="page-section__proof">
        <div v-for="(item, i) in section.items" :key="i" class="page-section__stat">
          <dt>{{ item.label }}</dt>
          <dd>{{ item.value }}</dd>
        </div>
      </dl>
    </template>

    <template v-else-if="section.type === 'benefits'">
      <h2 v-if="section.title">{{ section.title }}</h2>
      <div class="page-section__grid">
        <SwCard v-for="(item, i) in section.items" :key="i" :title="item.title">
          <PageRichText :text="item.body" />
        </SwCard>
      </div>
    </template>

    <template v-else-if="section.type === 'pricing'">
      <h2 v-if="section.title">{{ section.title }}</h2>
      <div class="page-section__grid">
        <SwCard
          v-for="(plan, i) in section.plans"
          :key="i"
          :eyebrow="plan.name"
          :title="plan.period ? `${plan.price} ${plan.period}` : plan.price"
          :class="{ 'page-section__plan--highlighted': plan.highlighted }"
        >
          <SwPill v-if="plan.highlighted" kind="solid">Recommended</SwPill>
          <ul class="rich__ul">
            <li v-for="(feature, f) in plan.features" :key="f">{{ feature }}</li>
          </ul>
          <template v-if="plan.cta" #footer>
            <PageLink :link="plan.cta" :kind="plan.highlighted ? 'primary' : 'secondary'" />
          </template>
        </SwCard>
      </div>
    </template>

    <template v-else-if="section.type === 'faq'">
      <h2 v-if="section.title">{{ section.title }}</h2>
      <template v-for="(item, i) in section.items" :key="i">
        <SwDivider v-if="i > 0" />
        <details class="page-section__faq">
          <summary>{{ item.question }}</summary>
          <PageRichText :text="item.answer" />
        </details>
      </template>
    </template>

    <SwCard v-else-if="section.type === 'cta'" :title="section.title">
      <PageRichText :text="section.body" />
      <template #footer>
        <PageLink :link="section.cta" />
      </template>
    </SwCard>

    <PageLeadForm v-else-if="section.type === 'lead'" :section="section" />
  </section>
</template>
