
import { defineStore } from 'pinia';
import { reactive } from 'vue';

export const useToastStore = defineStore('toast', () => {
  const toast = reactive({
    id: null,
    message: '',
    type: 'info',
    duration: 3000,
  });

  let timeoutId = null;

  function showToast(message, type = 'info', duration = 3000) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    toast.id = Date.now();
    toast.message = message;
    toast.type = type;
    toast.duration = duration; // 之前 duration 只用于 store 内部，组件里硬编码 3000

    // 错误提示不自动清除，交由用户手动关闭（Toast 组件里也做了同样的判断）
    if (type !== 'error') {
      timeoutId = setTimeout(() => {
        hideToast();
      }, duration);
    }
  }

  function hideToast() {
    toast.id = null;
  }

  return { toast, showToast, hideToast };
});
