<script setup>
/**
 * 会话过期后的「就地重新登录」对话框。
 *
 * 会话有 8 小时有效期。页面开着过夜后再点「保存更改」，后端会返回 401，
 * 之前只会弹一个英文 "Unauthorized" toast，用户必须刷新页面重新登录 ——
 * 而刷新会把所有未保存的修改一并丢掉。
 *
 * 这个对话框叠在原页面之上，Dashboard 不卸载，因此未保存的修改全部保留；
 * 重新登录成功后直接再点一次保存即可。
 */
import { ref, watch, nextTick } from 'vue';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';

const sessionStore = useSessionStore();
const { showToast } = useToastStore();

const password = ref('');
const error = ref('');
const isLoading = ref(false);
const inputRef = ref(null);

watch(() => sessionStore.sessionExpired, async (expired) => {
  if (expired) {
    password.value = '';
    error.value = '';
    await nextTick();
    inputRef.value?.focus();
  }
});

const submit = async () => {
  if (!password.value) {
    error.value = '请输入密码';
    return;
  }
  isLoading.value = true;
  error.value = '';
  try {
    await sessionStore.reauthenticate(password.value);
    showToast('已重新登录，请再次点击“保存更改”', 'success');
    password.value = '';
  } catch (e) {
    error.value = e.message || '登录失败';
  } finally {
    isLoading.value = false;
  }
};

const logoutInstead = () => {
  // 明确告知会丢失未保存的修改，由用户自己决定
  sessionStore.logout();
};
</script>

<template>
  <teleport to="body">
    <Transition name="reauth-fade">
      <div v-if="sessionStore.sessionExpired" class="fixed inset-0 z-[10001] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reauth-title"
          class="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-sm ring-1 ring-black/5 dark:ring-white/10 p-6"
          @click.stop
        >
          <div class="flex items-start gap-3">
            <div class="shrink-0 w-10 h-10 rounded-full bg-yellow-100 dark:bg-yellow-900/40 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-yellow-600 dark:text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h3 id="reauth-title" class="text-lg font-bold text-gray-900 dark:text-white">登录已过期</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                为安全起见，登录状态有效期为 8 小时。请重新输入密码继续操作。
              </p>
              <p class="text-xs text-green-600 dark:text-green-400 mt-2">
                ✓ 你未保存的修改仍然保留在页面上，重新登录后再点一次「保存更改」即可。
              </p>
            </div>
          </div>

          <form @submit.prevent="submit" class="mt-5 space-y-3">
            <input
              ref="inputRef"
              v-model="password"
              type="password"
              autocomplete="current-password"
              placeholder="请输入管理员密码"
              class="w-full px-3 py-2.5 bg-gray-100 dark:bg-gray-900 border-2 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-indigo-500 dark:text-white"
              :class="error ? 'border-red-500' : 'border-transparent'"
            />
            <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
            <button
              type="submit"
              :disabled="isLoading"
              class="w-full flex justify-center items-center gap-2 py-2.5 px-4 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-70 transition-colors"
            >
              <svg v-if="isLoading" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
              <span>{{ isLoading ? '登录中...' : '重新登录' }}</span>
            </button>
            <button
              type="button"
              @click="logoutInstead"
              class="w-full py-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              退出登录（将丢失未保存的修改）
            </button>
          </form>
        </div>
      </div>
    </Transition>
  </teleport>
</template>

<style scoped>
.reauth-fade-enter-active,
.reauth-fade-leave-active { transition: opacity 0.2s ease; }
.reauth-fade-enter-from,
.reauth-fade-leave-to { opacity: 0; }
</style>
