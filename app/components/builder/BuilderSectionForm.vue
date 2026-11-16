<script setup lang="ts">
import { SwButton, SwInput } from '@synthwerk/ui-vue'
// The form of one section. It edits the section in place; the page saves the whole draft.
// Long texts take the Markdown subset: **bold**, *italic*, [text](link), "- " lists.
import { LIMITS, type Section } from '#shared/sections'

const section = defineModel<Section>({ required: true })
const id = computed(() => `s-${section.value.id}`)

const MARKDOWN_HINT =
  'Markdown subset: **bold**, *italic*, [text](https://…), lines with "- " make a list.'

/** The lines of a textarea. Empty lines stay while typing and go when the field loses focus. */
const lines = (event: Event, clean: boolean) => {
  const all = (event.target as HTMLTextAreaElement).value.split('\n')
  return clean ? all.map((l) => l.trim()).filter((l) => l !== '') : all
}

function remove<T>(list: T[], index: number) {
  list.splice(index, 1)
}
</script>

<template>
  <div class="form">
    <template v-if="section.type === 'hero'">
      <div class="field">
        <label :for="`${id}-eyebrow`">Eyebrow (optional)</label>
        <SwInput :id="`${id}-eyebrow`" v-model="section.eyebrow" :maxlength="LIMITS.short" />
      </div>
      <div class="field">
        <label :for="`${id}-title`">Headline</label>
        <SwInput :id="`${id}-title`" v-model="section.title" :maxlength="LIMITS.short" />
      </div>
      <div class="field">
        <label :for="`${id}-body`">Text</label>
        <textarea
          :id="`${id}-body`"
          v-model="section.body"
          class="textarea"
          rows="4"
          :maxlength="LIMITS.long"
        />
        <span class="muted hint">{{ MARKDOWN_HINT }}</span>
      </div>
      <BuilderLinkField
        v-model="section.primary"
        legend="Main button"
        :id-prefix="`${id}-primary`"
        optional
      />
      <BuilderLinkField
        v-model="section.secondary"
        legend="Second button"
        :id-prefix="`${id}-secondary`"
        optional
      />
    </template>

    <template v-else-if="section.type === 'proof'">
      <div class="field">
        <label :for="`${id}-title`">Title (optional)</label>
        <SwInput :id="`${id}-title`" v-model="section.title" :maxlength="LIMITS.short" />
      </div>
      <div v-for="(item, i) in section.items" :key="i" class="builder-item">
        <div class="field">
          <label :for="`${id}-v${i}`">Number {{ i + 1 }}</label>
          <SwInput :id="`${id}-v${i}`" v-model="item.value" maxlength="24" />
        </div>
        <div class="field">
          <label :for="`${id}-l${i}`">Label {{ i + 1 }}</label>
          <SwInput :id="`${id}-l${i}`" v-model="item.label" :maxlength="LIMITS.short" />
        </div>
        <div class="builder-row">
          <SwButton
            kind="ghost"
            size="sm"
            :disabled="section.items.length <= 1"
            @click="remove(section.items, i)"
          >
            Remove number
          </SwButton>
        </div>
      </div>
      <div class="builder-row">
        <SwButton
          kind="secondary"
          size="sm"
          :disabled="section.items.length >= LIMITS.proofItems"
          @click="section.items.push({ value: '', label: '' })"
        >
          Add number
        </SwButton>
      </div>
    </template>

    <template v-else-if="section.type === 'benefits'">
      <div class="field">
        <label :for="`${id}-title`">Title (optional)</label>
        <SwInput :id="`${id}-title`" v-model="section.title" :maxlength="LIMITS.short" />
      </div>
      <div v-for="(item, i) in section.items" :key="i" class="builder-item">
        <div class="field">
          <label :for="`${id}-t${i}`">Benefit {{ i + 1 }}</label>
          <SwInput :id="`${id}-t${i}`" v-model="item.title" :maxlength="LIMITS.short" />
        </div>
        <div class="field">
          <label :for="`${id}-b${i}`">Text {{ i + 1 }}</label>
          <textarea
            :id="`${id}-b${i}`"
            v-model="item.body"
            class="textarea"
            rows="3"
            :maxlength="LIMITS.long"
          />
        </div>
        <div class="builder-row">
          <SwButton
            kind="ghost"
            size="sm"
            :disabled="section.items.length <= 1"
            @click="remove(section.items, i)"
          >
            Remove benefit
          </SwButton>
        </div>
      </div>
      <span class="muted hint">{{ MARKDOWN_HINT }}</span>
      <div class="builder-row">
        <SwButton
          kind="secondary"
          size="sm"
          :disabled="section.items.length >= LIMITS.benefitItems"
          @click="section.items.push({ title: '', body: '' })"
        >
          Add benefit
        </SwButton>
      </div>
    </template>

    <template v-else-if="section.type === 'pricing'">
      <div class="field">
        <label :for="`${id}-title`">Title (optional)</label>
        <SwInput :id="`${id}-title`" v-model="section.title" :maxlength="LIMITS.short" />
      </div>
      <div v-for="(plan, i) in section.plans" :key="i" class="builder-item">
        <div class="field">
          <label :for="`${id}-n${i}`">Plan {{ i + 1 }} name</label>
          <SwInput :id="`${id}-n${i}`" v-model="plan.name" :maxlength="LIMITS.short" />
        </div>
        <div class="field">
          <label :for="`${id}-p${i}`">Price</label>
          <SwInput :id="`${id}-p${i}`" v-model="plan.price" maxlength="40" />
        </div>
        <div class="field">
          <label :for="`${id}-per${i}`">Period (optional)</label>
          <SwInput :id="`${id}-per${i}`" v-model="plan.period" maxlength="40" />
        </div>
        <div class="field">
          <label :for="`${id}-f${i}`">Features, one per line</label>
          <textarea
            :id="`${id}-f${i}`"
            class="textarea"
            rows="4"
            :value="plan.features.join('\n')"
            @input="plan.features = lines($event, false)"
            @change="plan.features = lines($event, true)"
          />
        </div>
        <label class="check">
          <input v-model="plan.highlighted" type="checkbox">
          <span>Recommended plan</span>
        </label>
        <BuilderLinkField
          v-model="plan.cta"
          legend="Plan button"
          :id-prefix="`${id}-c${i}`"
          optional
        />
        <div class="builder-row">
          <SwButton
            kind="ghost"
            size="sm"
            :disabled="section.plans.length <= 1"
            @click="remove(section.plans, i)"
          >
            Remove plan
          </SwButton>
        </div>
      </div>
      <div class="builder-row">
        <SwButton
          kind="secondary"
          size="sm"
          :disabled="section.plans.length >= LIMITS.plans"
          @click="section.plans.push({ name: '', price: '', period: '', features: [], highlighted: false, cta: null })"
        >
          Add plan
        </SwButton>
      </div>
    </template>

    <template v-else-if="section.type === 'faq'">
      <div class="field">
        <label :for="`${id}-title`">Title (optional)</label>
        <SwInput :id="`${id}-title`" v-model="section.title" :maxlength="LIMITS.short" />
      </div>
      <div v-for="(item, i) in section.items" :key="i" class="builder-item">
        <div class="field">
          <label :for="`${id}-q${i}`">Question {{ i + 1 }}</label>
          <SwInput :id="`${id}-q${i}`" v-model="item.question" :maxlength="LIMITS.short * 2" />
        </div>
        <div class="field">
          <label :for="`${id}-a${i}`">Answer {{ i + 1 }}</label>
          <textarea
            :id="`${id}-a${i}`"
            v-model="item.answer"
            class="textarea"
            rows="3"
            :maxlength="LIMITS.long"
          />
        </div>
        <div class="builder-row">
          <SwButton
            kind="ghost"
            size="sm"
            :disabled="section.items.length <= 1"
            @click="remove(section.items, i)"
          >
            Remove question
          </SwButton>
        </div>
      </div>
      <span class="muted hint">{{ MARKDOWN_HINT }}</span>
      <div class="builder-row">
        <SwButton
          kind="secondary"
          size="sm"
          :disabled="section.items.length >= LIMITS.faqItems"
          @click="section.items.push({ question: '', answer: '' })"
        >
          Add question
        </SwButton>
      </div>
    </template>

    <template v-else-if="section.type === 'cta'">
      <div class="field">
        <label :for="`${id}-title`">Title</label>
        <SwInput :id="`${id}-title`" v-model="section.title" :maxlength="LIMITS.short" />
      </div>
      <div class="field">
        <label :for="`${id}-body`">Text (optional)</label>
        <textarea
          :id="`${id}-body`"
          v-model="section.body"
          class="textarea"
          rows="3"
          :maxlength="LIMITS.long"
        />
        <span class="muted hint">{{ MARKDOWN_HINT }}</span>
      </div>
      <BuilderLinkField v-model="section.cta" legend="Button" :id-prefix="`${id}-cta`" />
    </template>

    <template v-else-if="section.type === 'lead'">
      <p class="muted hint">
        Fixed fields: email, an optional name and a consent checkbox. The visitor confirms the
        address by mail; only then the lead shows under Leads.
      </p>
      <div class="field">
        <label :for="`${id}-title`">Title</label>
        <SwInput :id="`${id}-title`" v-model="section.title" :maxlength="LIMITS.short" />
      </div>
      <div class="field">
        <label :for="`${id}-body`">Text (optional)</label>
        <textarea
          :id="`${id}-body`"
          v-model="section.body"
          class="textarea"
          rows="3"
          :maxlength="LIMITS.long"
        />
        <span class="muted hint">{{ MARKDOWN_HINT }}</span>
      </div>
      <label class="check">
        <input v-model="section.nameField" type="checkbox">
        Ask for a name too (optional field; leave off when the email is enough)
      </label>
      <div class="field">
        <label :for="`${id}-consent`">Consent text</label>
        <textarea
          :id="`${id}-consent`"
          v-model="section.consent"
          class="textarea"
          rows="3"
          :maxlength="LIMITS.long"
        />
        <span class="muted hint">
          Shows next to the checkbox. Say what you store and why, and link the privacy page. Each
          lead keeps the text the visitor agreed to.
        </span>
      </div>
      <div class="field">
        <label :for="`${id}-button`">Button label</label>
        <SwInput :id="`${id}-button`" v-model="section.button" :maxlength="LIMITS.label" />
      </div>
    </template>
  </div>
</template>
