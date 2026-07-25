<script setup>
import { ref, watch, onUnmounted } from 'vue';
import { useToastStore } from '../stores/toast.js';

const { toast, hideToast } = useToastStore();
const isVisible = ref(false);
// 单一定时器句柄：之前每条消息都新建一个 3 秒定时器且从不清理，
// 前一条的定时器会把后一条提前掐掉（第二条只显示不到 3 秒就消失）。
let timer = null;

watch(() => toast.id, () => {
  clearTimeout(timer);
  if (toast.message && toast.id !== null) {
    isVisible.value = true;
    // 错误提示常驻，直到用户手动关闭或被下一条消息覆盖 —— 报错内容一闪而过很难读完
    if (toast.type !== 'error') {
      timer = setTimeout(() => { isVisible.value = false; }, toast.duration || 3000);
    }
  } else {
    isVisible.value = false;
  }
});

const dismiss = () => {
  clearTimeout(timer);
  isVisible.value = false;
  hideToast();
};

onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <!-- teleport + z-[10000]：弹窗遮罩是 z-[9999]，
       之前 toast 只有 z-100，弹窗打开时所有提示都被磨砂遮罩盖在下面看不见。 -->
  <teleport to="body">
    <Transition name="toast">
      <div
        v-if="isVisible"
        role="status"
        aria-live="polite"
        class="fixed top-5 left-1/2 -translate-x-1/2 z-[10000] max-w-[90vw] px-5 py-3 rounded-lg shadow-lg text-white font-semibold text-sm flex items-center gap-3"
        :class="{
          'bg-green-500': toast.type === 'success',
          'bg-red-500': toast.type === 'error',
          'bg-blue-500': toast.type === 'info' || !toast.type
        }"
      >
        <span class="break-words">{{ toast.message }}</span>
        <button
          @click="dismiss"
          aria-label="关闭提示"
          class="shrink-0 -mr-1 p-1 rounded-full hover:bg-white/20 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </Transition>
  </teleport>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-20px) translateX(-50%);
}
.toast-enter-to,
.toast-leave-from {
    transform: translateY(0) translateX(-50%);
}
</style>
