<script setup lang="ts">
// The studio navigation. Add a page here with one line.
const links = [
  { to: '/me', label: 'Me' },
  { to: '/apps', label: 'Apps' },
  { to: '/users', label: 'Users' },
  { to: '/audit', label: 'Audit' }
]
</script>

<template>
  <nav class="studio-nav" aria-label="Studio">
    <NuxtLink v-for="link in links" :key="link.to" :to="link.to" class="studio-nav__link">
      {{ link.label }}
    </NuxtLink>
  </nav>
</template>
