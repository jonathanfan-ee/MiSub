
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fetchInitialData, login as apiLogin, setUnauthorizedHandler } from '../lib/api.js';

export const useSessionStore = defineStore('session', () => {
  const sessionState = ref('loading'); // loading, loggedIn, loggedOut
  const initialData = ref(null);
  // 会话过期标记。刻意不切到 loggedOut：那样会卸载整个 Dashboard，
  // 用户尚未保存的修改会全部丢失。这里改为在原页面上叠一层重新登录对话框。
  const sessionExpired = ref(false);

  setUnauthorizedHandler(() => {
    if (sessionState.value === 'loggedIn') sessionExpired.value = true;
  });

  /** 就地重新登录：成功后关闭对话框，页面上未保存的修改依然在。 */
  async function reauthenticate(password) {
    const response = await apiLogin(password);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || '登录失败');
    }
    sessionExpired.value = false;
    return true;
  }

  async function checkSession() {
    try {
      const data = await fetchInitialData();
      if (data) {
        initialData.value = data;
        sessionState.value = 'loggedIn';
      } else {
        sessionState.value = 'loggedOut';
      }
    } catch (error) {
      console.error("Session check failed:", error);
      sessionState.value = 'loggedOut';
    }
  }

  async function login(password) {
    try {
      const response = await apiLogin(password);
      if (response.ok) {
        handleLoginSuccess();
      } else {
        const errData = await response.json();
        throw new Error(errData.error || '登录失败');
      }
    } catch(e) {
      throw e;
    }
  }

  function handleLoginSuccess() {
    sessionState.value = 'loading';
    checkSession();
  }

  /**
   * 重新拉取一次后端数据（保存设置后用）。
   * 与 checkSession 的区别：不切换到 loading 状态，因此不会把整个仪表盘卸载重建，
   * 用来替代之前保存设置后的 window.location.reload()。
   */
  async function refreshData() {
    try {
      const data = await fetchInitialData();
      if (data) initialData.value = data;
      return !!data;
    } catch (error) {
      console.error('Refresh data failed:', error);
      return false;
    }
  }

  async function logout() {
    try {
      await fetch('/api/logout');
    } catch (e) {
      // 网络失败也要让用户退出登录状态，不能卡在已登录界面
      console.error('Logout request failed:', e);
    }
    sessionState.value = 'loggedOut';
    initialData.value = null;
    sessionExpired.value = false;
  }

  return { sessionState, initialData, sessionExpired, checkSession, refreshData, login, logout, reauthenticate };
});
