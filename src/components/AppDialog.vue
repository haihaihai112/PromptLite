<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import AppIcon from './AppIcon.vue';
defineProps<{ title: string; wide?: boolean; busy?: boolean; notice?: { text: string; error: boolean } | null }>();
const emit = defineEmits<{ close: []; dismiss: [] }>();
const dialog = ref<HTMLDialogElement>();
const previousFocus = document.activeElement as HTMLElement | null;
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => previousFocus?.focus());
function cancel(event: Event) { event.preventDefault(); emit('close'); }
</script>

<template>
  <dialog ref="dialog" :class="['app-dialog', { wide }]" aria-labelledby="dialog-title" @cancel="cancel">
    <header class="dialog-header"><h2 id="dialog-title">{{ title }}</h2><button class="icon-button" aria-label="关闭对话框" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></header>
    <div v-if="notice" :class="['dialog-notice', { error: notice.error }]" :role="notice.error ? 'alert' : 'status'"><span>{{ notice.text }}</span><button class="icon-button" aria-label="关闭通知" @click="emit('dismiss')"><AppIcon name="close" :size="15" /></button></div>
    <div class="dialog-content"><slot /></div>
  </dialog>
</template>
