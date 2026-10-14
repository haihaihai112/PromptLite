<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  work: 'M4 4h16v16H4z M12 4v16 M7 8h2 M15 8h2 M7 12h2 M15 12h2',
  history: 'M3 11a9 9 0 1 1 2.6 7 M3 4v7h7 M12 7v5l3 2',
  star: 'm12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6.3-.9z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14 M14 7l5 5-5 5',
  copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
  close: 'M6 6l12 12 M6 18 18 6',
  down: 'm6 9 6 6 6-6',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  download: 'M12 3v13 M7 11l5 5 5-5 M4 15v6h16v-6',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  trash: 'M3 6h18 M8 6V3h8v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  check: 'm5 12 4 4L19 6',
  stop: 'M6 6h12v12H6z',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-7z',
};
</script>

<template>
  <svg :width="size || 18" :height="size || 18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.work" /></svg>
</template>
