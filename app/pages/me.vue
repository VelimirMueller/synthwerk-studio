<script setup lang="ts">
import { SwButton, SwCard, SwInput, SwPill } from '@synthwerk/ui-vue'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const { session, signOut } = useAuthSession()
const { deleteAccount } = useAccount()
const pending = ref(false)

async function onSignOut() {
  pending.value = true
  try {
    await signOut()
  } finally {
    pending.value = false
  }
}

// Delete account (synthwerk#41): explain, sign in again (step-up), then type DELETE to confirm.
const CONFIRM_WORD = DELETE_CONFIRM_WORD
const asking = ref(false)
const confirmText = ref('')
const deleting = ref(false)
const deleteError = ref('')
const view = computed(() =>
  deleteAccountView(route.query.delete, session.value?.stepUp, Date.now())
)
const deleteStep = computed(() => view.value.step)
const deleteNotice = computed(() => view.value.notice)

function reauth() {
  return navigateTo(deleteAccountReauthUrl, { external: true })
}

function cancelDelete() {
  asking.value = false
  confirmText.value = ''
  deleteError.value = ''
  return navigateTo('/me', { replace: true })
}

async function onDelete() {
  if (confirmText.value.trim() !== CONFIRM_WORD) return
  deleting.value = true
  deleteError.value = ''
  try {
    await deleteAccount()
    session.value = null
    await navigateTo('/?deleted=1', { replace: true })
  } catch (err) {
    deleteError.value = deleteAccountErrorText(err)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <main v-if="session" class="page">
    <StudioNav />
    <h1>{{ session.org.name || 'Your org' }}</h1>
    <SwCard eyebrow="Signed in as" :title="session.user.name || session.user.username">
      <dl class="facts">
        <dt>User name</dt>
        <dd>{{ session.user.username }}</dd>
        <dt>Email</dt>
        <dd>{{ session.user.email || '-' }}</dd>
        <dt>Org</dt>
        <dd>{{ session.org.name }} <span class="muted">{{ session.org.id }}</span></dd>
        <dt>Roles</dt>
        <dd>
          <SwPill v-for="r in session.roles" :key="r.role" kind="accent">{{ r.role }}</SwPill>
          <span v-if="session.roles.length === 0" class="muted">none</span>
        </dd>
        <dt>Sign-in factors</dt>
        <dd>
          <SwPill v-for="m in session.amr" :key="m">{{ m }}</SwPill>
          <span v-if="session.amr.length === 0" class="muted">not reported</span>
        </dd>
      </dl>
      <template #footer>
        <SwButton kind="secondary" :disabled="pending" @click="onSignOut">Sign out</SwButton>
      </template>
    </SwCard>

    <SwCard eyebrow="Danger" title="Delete your account">
      <p v-if="deleteNotice" class="notice" role="alert">{{ deleteNotice }}</p>
      <template v-if="deleteStep === 'confirm'">
        <p>
          You signed in again. Type <strong class="mono">{{ CONFIRM_WORD }}</strong> to delete your
          account now. This cannot be undone.
        </p>
        <form class="form" @submit.prevent="onDelete">
          <div class="field">
            <label for="delete-confirm">Confirmation</label>
            <SwInput id="delete-confirm" v-model="confirmText" autocomplete="off" />
          </div>
          <p v-if="deleteError" class="notice" role="alert">{{ deleteError }}</p>
          <div class="pills">
            <SwButton type="submit" :disabled="deleting || confirmText.trim() !== CONFIRM_WORD">
              Delete my account
            </SwButton>
            <SwButton kind="ghost" :disabled="deleting" @click="cancelDelete">Cancel</SwButton>
          </div>
        </form>
      </template>
      <template v-else-if="asking">
        <ul>
          <li>Synthwerk deletes your memberships, invitations and data in every service.</li>
          <li>An org where you are the only member closes, with its apps.</li>
          <li>
            If you are the only owner of an org with other members, make another member owner first.
          </li>
        </ul>
        <p class="muted">To protect your account, sign in again with your second factor first.</p>
        <div class="pills">
          <SwButton @click="reauth">Sign in again to continue</SwButton>
          <SwButton kind="ghost" @click="cancelDelete">Cancel</SwButton>
        </div>
      </template>
      <template v-else>
        <p class="muted">Delete your Synthwerk account and your data. This cannot be undone.</p>
        <SwButton kind="secondary" @click="asking = true">Delete account</SwButton>
      </template>
    </SwCard>
  </main>
</template>
