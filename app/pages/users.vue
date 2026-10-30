<script setup lang="ts">
import { SwButton, SwCard, SwInput, SwStatusPill } from '@synthwerk/ui-vue'

definePageMeta({ middleware: 'auth' })

const { session } = useAuthSession()
const api = useOrgApi()
const roles: OrgRole[] = ['owner', 'admin', 'member']

const members = ref<OrgMember[]>([])
const cursor = ref<string | undefined>()
const loading = ref(false)
const loaded = ref(false)
/** User id of the row with a running change. */
const busy = ref('')
const error = ref('')
const notice = ref('')

const invitations = ref<OrgInvitation[]>([])
const invitationsCursor = ref<string | undefined>()

const email = ref('')
const inviteRole = ref<OrgRole>('member')
const inviting = ref(false)

const me = computed(() => session.value?.user.sub ?? '')

async function handle(err: unknown) {
  const e = orgApiError(err)
  if (e.status === 401) return navigateTo(signInUrl('/users'), { external: true })
  error.value = orgErrorText(e)
}

async function load(more = false) {
  loading.value = true
  error.value = ''
  try {
    const page = await api.listMembers(more ? cursor.value : undefined)
    members.value = more ? [...members.value, ...page.items] : page.items
    cursor.value = page.next_cursor
    if (!more) await loadInvitations()
    loaded.value = true
  } catch (err) {
    await handle(err)
  } finally {
    loading.value = false
  }
}

async function loadInvitations(more = false) {
  const page = await api.listInvitations(more ? invitationsCursor.value : undefined)
  invitations.value = more ? [...invitations.value, ...page.items] : page.items
  invitationsCursor.value = page.next_cursor
}

async function moreInvitations() {
  error.value = ''
  try {
    await loadInvitations(true)
  } catch (err) {
    await handle(err)
  }
}

async function revoke(inv: OrgInvitation) {
  busy.value = inv.id
  error.value = ''
  notice.value = ''
  try {
    await api.revokeInvitation(inv.id)
    invitations.value = invitations.value.filter((i) => i.id !== inv.id)
    notice.value = `The invitation for ${inv.email} is revoked.`
  } catch (err) {
    await handle(err)
  } finally {
    busy.value = ''
  }
}

function replace(member: OrgMember) {
  members.value = members.value.map((m) => (m.user_id === member.user_id ? member : m))
}

async function act(userId: string, action: () => Promise<OrgMember>, done: string) {
  busy.value = userId
  error.value = ''
  notice.value = ''
  try {
    replace(await action())
    notice.value = done
  } catch (err) {
    await handle(err)
  } finally {
    busy.value = ''
  }
}

function onRole(member: OrgMember, event: Event) {
  const select = event.target as HTMLSelectElement
  const role = select.value as OrgRole
  if (role === member.role) return
  // Show the stored role again until identity accepts the change.
  select.value = member.role
  return act(
    member.user_id,
    () => api.changeRole(member.user_id, role),
    `User ${member.user_id} is ${role} now.`
  )
}

const deactivate = (m: OrgMember) =>
  act(m.user_id, () => api.deactivate(m.user_id), `User ${m.user_id} is deactivated.`)
const reactivate = (m: OrgMember) =>
  act(m.user_id, () => api.reactivate(m.user_id), `User ${m.user_id} is active again.`)

async function invite() {
  inviting.value = true
  error.value = ''
  notice.value = ''
  try {
    const inv = await api.invite(email.value.trim(), inviteRole.value)
    invitations.value = [inv, ...invitations.value.filter((i) => i.id !== inv.id)]
    notice.value = `${inv.email} is invited. The user shows in the list after the first sign-in.`
    email.value = ''
    inviteRole.value = 'member'
  } catch (err) {
    await handle(err)
  } finally {
    inviting.value = false
  }
}

const date = (value: string) => {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

onMounted(() => load())
</script>

<template>
  <main class="page">
    <StudioNav />
    <h1>Users</h1>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>

    <SwCard eyebrow="Invite" title="Invite a user">
      <form class="invite" @submit.prevent="invite">
        <div class="field">
          <label class="muted" for="invite-email">Email</label>
          <SwInput id="invite-email" v-model="email" type="email" :disabled="inviting" />
        </div>
        <label class="field">
          <span class="muted">Role</span>
          <select v-model="inviteRole" class="select" :disabled="inviting">
            <option v-for="r in roles" :key="r" :value="r">{{ r }}</option>
          </select>
        </label>
        <SwButton type="submit" :disabled="inviting || email.trim() === ''">Send invite</SwButton>
      </form>
      <p class="muted">Zitadel sends the invite mail. Only an owner can invite an owner.</p>
    </SwCard>

    <h2>Pending invitations</h2>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Invited by</th>
            <th scope="col">Invited</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in invitations" :key="inv.id">
            <td>{{ inv.email }}</td>
            <td>{{ inv.role }}</td>
            <td class="mono">{{ inv.invited_by }}</td>
            <td class="muted">{{ date(inv.created_at) }}</td>
            <td>
              <SwButton kind="ghost" size="sm" :disabled="busy !== ''" @click="revoke(inv)">
                Revoke
              </SwButton>
            </td>
          </tr>
          <tr v-if="loaded && invitations.length === 0">
            <td colspan="5" class="muted">No pending invitations.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <SwButton v-if="invitationsCursor" kind="secondary" @click="moreInvitations">
      More invitations
    </SwButton>

    <h2>Users</h2>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">User id</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in members" :key="m.user_id">
            <td class="mono">
              {{ m.user_id }}
              <span v-if="m.user_id === me" class="muted">(you)</span>
            </td>
            <td>
              <select
                class="select"
                :value="m.role"
                :aria-label="`Role of ${m.user_id}`"
                :disabled="m.user_id === me || busy !== ''"
                @change="onRole(m, $event)"
              >
                <option v-for="r in roles" :key="r" :value="r">{{ r }}</option>
              </select>
            </td>
            <td>
              <span v-if="m.status === 'active'">Active</span>
              <SwStatusPill v-else status="planned">Deactivated</SwStatusPill>
            </td>
            <td class="muted">{{ date(m.updated_at) }}</td>
            <td>
              <SwButton
                v-if="m.status === 'active'"
                kind="ghost"
                size="sm"
                :disabled="m.user_id === me || busy !== ''"
                @click="deactivate(m)"
              >
                Deactivate
              </SwButton>
              <SwButton
                v-else
                kind="ghost"
                size="sm"
                :disabled="m.user_id === me || busy !== ''"
                @click="reactivate(m)"
              >
                Reactivate
              </SwButton>
            </td>
          </tr>
          <tr v-if="loaded && members.length === 0">
            <td colspan="5" class="muted">No users.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="loading" class="muted" role="status">Loading…</p>
    <SwButton v-if="cursor && !loading" kind="secondary" @click="load(true)">Load more</SwButton>
  </main>
</template>
