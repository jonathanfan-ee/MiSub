<script setup>
import { ref, watch, nextTick, onUnmounted } from 'vue';
import { Transition } from 'vue';

const props = defineProps({
  show: Boolean,
  confirmKeyword: String,
  size: {
    type: String,
    default: 'sm',
  },
  // --- 新增 props ---
  confirmDisabled: { // 用於接收外部傳入的禁用狀態
    type: Boolean,
    default: false,
  },
  confirmButtonTitle: { // 用於在禁用時顯示提示
    type: String,
    default: '确认'
  },
  confirmText: {        // 确认按钮文案，例如「导入」「迁移」
    type: String,
    default: '确认',
  },
  cancelText: {
    type: String,
    default: '取消',
  },
  danger: {             // 危险操作：确认按钮显示为红色
    type: Boolean,
    default: false,
  },
  // 点「确认」后是否自动关闭。
  // 需要做校验的弹窗必须传 false，否则校验失败时弹窗照样关闭，
  // 用户既看不到错误提示，也丢掉了已经填好的内容。
  closeOnConfirm: {
    type: Boolean,
    default: true,
  },
  isSaving: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['update:show', 'confirm']);

const confirmInput = ref('');
const panelRef = ref(null);

const close = () => emit('update:show', false);

const handleConfirm = () => {
  if (props.confirmDisabled || props.isSaving) return;
  if (props.confirmKeyword && confirmInput.value !== props.confirmKeyword) return;
  emit('confirm');
  if (props.closeOnConfirm) close();
};

const handleKeydown = (e) => {
  // 只有本弹窗处于显示状态时才响应键盘。
  // 之前无条件监听，页面上每个已挂载的 Modal 都会响应 Esc。
  if (!props.show) return;

  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
    return;
  }

  // Enter 提交；多行输入里 Enter 是换行，需要 Ctrl/Cmd+Enter
  if (e.key === 'Enter') {
    const tag = (e.target?.tagName || '').toLowerCase();
    const isTextarea = tag === 'textarea';
    if (isTextarea && !(e.ctrlKey || e.metaKey)) return;
    if (tag === 'button' || tag === 'a') return; // 让按钮自己处理
    e.preventDefault();
    handleConfirm();
    return;
  }

  // 焦点陷阱：Tab 在弹窗内循环，不要跑到背后的页面上
  if (e.key === 'Tab' && panelRef.value) {
    const focusable = panelRef.value.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
};

let previousOverflow = '';
let previouslyFocused = null;

watch(() => props.show, async (visible) => {
  if (visible) {
    confirmInput.value = '';
    previouslyFocused = document.activeElement;
    // 打开时锁定页面滚动，否则背后的长列表会跟着滚
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeydown);
    await nextTick();
    // 自动聚焦第一个输入框，省掉一次鼠标点击
    const target = panelRef.value?.querySelector(
      'input:not([type="hidden"]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), select:not([disabled])'
    );
    if (target) target.focus();
    else panelRef.value?.focus();
  } else {
    window.removeEventListener('keydown', handleKeydown);
    document.body.style.overflow = previousOverflow;
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
  }
}, { immediate: true });

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  // 组件在弹窗仍打开时被卸载（例如 v-if 切换）时不要把 body 滚动锁死
  if (props.show) document.body.style.overflow = previousOverflow;
});
</script>

<template>
  <teleport to="body">
    <Transition name="modal-fade">
      <div
        v-if="show"
        class="fixed inset-0 bg-black/60 backdrop-blur-xs z-[9999] flex items-center justify-center p-4"
        @click="close"
      >
        <Transition name="modal-inner">
          <div
            v-if="show"
            ref="panelRef"
            role="dialog"
            aria-modal="true"
            tabindex="-1"
            class="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full text-left ring-1 ring-black/5 dark:ring-white/10 flex flex-col max-h-[85vh] focus:outline-hidden"
            :class="{
              'max-w-sm': size === 'sm',
              'max-w-lg': size === 'lg',
              'max-w-2xl': size === '2xl'
            }"
            @click.stop
          >
            <div class="p-6 pb-4 shrink-0">
              <slot name="title">
                <h3 class="text-lg font-bold text-gray-900 dark:text-white">确认操作</h3>
              </slot>
            </div>

            <div class="px-6 pb-6 grow overflow-y-auto">
               <slot name="body">
                  <p class="text-sm text-gray-500 dark:text-gray-400">你确定要继续吗？</p>
              </slot>
              <!-- confirmKeyword 的输入框。
                   之前 Modal 声明了 confirmKeyword 并用它禁用确认按钮，
                   却从来没渲染输入框 —— 一旦传入这个 prop，弹窗就永远无法确认。 -->
              <div v-if="confirmKeyword" class="mt-4">
                <input
                  v-model="confirmInput"
                  type="text"
                  :placeholder="confirmKeyword"
                  autocomplete="off"
                  class="block w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-red-500 focus:border-red-500 sm:text-sm font-mono dark:text-white"
                />
              </div>
            </div>

            <div class="p-6 pt-4 flex justify-end space-x-3 shrink-0 border-t border-gray-200 dark:border-gray-700">
              <slot name="footer-extra" />
              <button @click="close" class="px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-semibold text-sm rounded-lg transition-colors">{{ cancelText }}</button>
              <button
                  @click="handleConfirm"
                  :disabled="confirmDisabled || isSaving || (confirmKeyword && confirmInput !== confirmKeyword)"
                  :title="confirmDisabled ? confirmButtonTitle : confirmText"
                  class="px-4 py-2 text-white font-semibold text-sm rounded-lg transition-colors disabled:bg-gray-400 dark:disabled:bg-gray-600 disabled:opacity-70 disabled:cursor-not-allowed inline-flex items-center gap-2"
                  :class="danger ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'"
              >
                <svg v-if="isSaving" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                <span>{{ isSaving ? '处理中...' : confirmText }}</span>
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </teleport>
</template>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease;
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
.modal-inner-enter-active,
.modal-inner-leave-active {
  transition: all 0.25s ease;
}
.modal-inner-enter-from,
.modal-inner-leave-to {
  opacity: 0;
  transform: translateY(50px);
}
@media (min-width: 768px) {
  .modal-inner-enter-from,
  .modal-inner-leave-to {
    opacity: 0;
    transform: scale(0.95);
  }
}
</style>
