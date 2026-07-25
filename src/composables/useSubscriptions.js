// FILE: src/composables/useSubscriptions.js
import { ref, computed, watch } from 'vue';
import { fetchNodeCount, batchUpdateNodes } from '../lib/api.js';
import { useToastStore } from '../stores/toast.js';

export function useSubscriptions(initialSubsRef, markDirty) {
  const { showToast } = useToastStore();
  const subscriptions = ref([]);
  const subsCurrentPage = ref(1);
  const subsItemsPerPage = 6;

  function initializeSubscriptions(subsData) {
    subscriptions.value = (subsData || []).map(sub => ({
      ...sub,
      id: sub.id || crypto.randomUUID(),
      enabled: sub.enabled ?? true,
      nodeCount: sub.nodeCount || 0,
      isUpdating: false,
      userInfo: sub.userInfo || null,
      exclude: sub.exclude || '', // 新增 exclude 属性
      // 新增：聚合实时拉取控制与缓存字段
      realtimeFetch: sub.realtimeFetch !== false, // 默认开启实时拉取
      cachedRaw: sub.cachedRaw || '',
      cachedAt: sub.cachedAt || null,
      cachedFromUrl: sub.cachedFromUrl || null,
      cachedRawPresent: typeof sub.cachedRawPresent === 'boolean' ? sub.cachedRawPresent : Boolean(sub.cachedRaw && sub.cachedRaw.length > 0),
    }));
    // [最終修正] 移除此處的自動更新迴圈，以防止本地開發伺服器因併發請求過多而崩潰。
    // subscriptions.value.forEach(sub => handleUpdateNodeCount(sub.id, true)); 
  }

  const enabledSubscriptions = computed(() => subscriptions.value.filter(s => s.enabled));

  const totalRemainingTraffic = computed(() => {
    const REASONABLE_TRAFFIC_LIMIT_BYTES = 10 * 1024 * 1024 * 1024 * 1024 * 1024; // 10 PB in bytes
    return subscriptions.value.reduce((acc, sub) => {
      if (
        sub.enabled &&
        sub.userInfo &&
        sub.userInfo.total > 0 &&
        sub.userInfo.total < REASONABLE_TRAFFIC_LIMIT_BYTES
      ) {
        const used = (sub.userInfo.upload || 0) + (sub.userInfo.download || 0);
        const remaining = sub.userInfo.total - used;
        return acc + Math.max(0, remaining);
      }
      return acc;
    }, 0);
  });

  const subsTotalPages = computed(() => Math.ceil(subscriptions.value.length / subsItemsPerPage));
  const paginatedSubscriptions = computed(() => {
    const start = (subsCurrentPage.value - 1) * subsItemsPerPage;
    const end = start + subsItemsPerPage;
    return subscriptions.value.slice(start, end);
  });

  function changeSubsPage(page) {
    if (page < 1 || page > subsTotalPages.value) return;
    subsCurrentPage.value = page;
  }

  async function handleUpdateNodeCount(subId, isInitialLoad = false) {
    const subToUpdate = subscriptions.value.find(s => s.id === subId);
    if (!subToUpdate || !subToUpdate.url.startsWith('http')) return;

    if (!isInitialLoad) {
      subToUpdate.isUpdating = true;
    }

    try {
      const data = await fetchNodeCount(subToUpdate.url, subToUpdate.id);
      // 兑现「订阅名称不填将自动获取」：优先用机场声明的名称，
      // 后端取不到时会退回主机名，总之不再留下「未命名订阅」。
      if ((!subToUpdate.name || !subToUpdate.name.trim()) && data.name) {
        subToUpdate.name = data.name;
      }
      subToUpdate.nodeCount = data.count || 0;
      subToUpdate.userInfo = data.userInfo || null;
      if (typeof data.cachedAt !== 'undefined') {
        subToUpdate.cachedAt = data.cachedAt;
      }
      // 後端若帶回 cachedRawPresent 與 cachedRaw，保持一致
      if (typeof data.cachedRawPresent !== 'undefined') {
        subToUpdate.cachedRawPresent = !!data.cachedRawPresent;
        if (!data.cachedRawPresent) {
          subToUpdate.cachedRaw = '';
        }
      }
      if (typeof data.cachedRaw === 'string') {
        subToUpdate.cachedRaw = data.cachedRaw;
        subToUpdate.cachedRawPresent = subToUpdate.cachedRaw.length > 0;
      }

      if (!isInitialLoad) {
        showToast(`${subToUpdate.name || '订阅'} 更新成功！`, 'success');
        markDirty();
      }
    } catch (error) {
      if (!isInitialLoad) showToast(`${subToUpdate.name || '订阅'} 更新失败`, 'error');
      console.error(`Failed to fetch node count for ${subToUpdate.name}:`, error);
    } finally {
      subToUpdate.isUpdating = false;
    }
  }

  function addSubscription(sub) {
    subscriptions.value.unshift(sub);
    subsCurrentPage.value = 1;
    handleUpdateNodeCount(sub.id); // 新增時自動更新單個
    markDirty();
  }

  function updateSubscription(updatedSub) {
    const index = subscriptions.value.findIndex(s => s.id === updatedSub.id);
    if (index !== -1) {
      const urlChanged = subscriptions.value[index].url !== updatedSub.url;
      if (urlChanged) {
        updatedSub.nodeCount = 0;
        // URL 变更时清空缓存，以避免使用旧缓存
        updatedSub.cachedRaw = '';
        updatedSub.cachedAt = null;
        updatedSub.cachedFromUrl = null;
        updatedSub.cachedRawPresent = false;
        updatedSub.userInfo = null;
      }
      // 必须先把新对象写进数组，再触发刷新。
      // 之前的顺序相反：handleUpdateNodeCount 会通过 id 从数组里取到「旧」对象，
      // 于是请求发的是旧 URL，拿到的结果又写在随后被替换掉的旧对象上 ——
      // 改完地址点保存，节点数和流量永远不更新。
      subscriptions.value[index] = updatedSub;
      markDirty();
      if (urlChanged) {
        handleUpdateNodeCount(updatedSub.id); // URL 變更時自動更新單個
      }
    }
  }

  function deleteSubscription(subId) {
    subscriptions.value = subscriptions.value.filter((s) => s.id !== subId);
    if (paginatedSubscriptions.value.length === 0 && subsCurrentPage.value > 1) {
      subsCurrentPage.value--;
    }
    markDirty();
  }

  function deleteAllSubscriptions() {
    subscriptions.value = [];
    subsCurrentPage.value = 1;
    markDirty();
  }

  /**
   * 把后端批量更新的结果合并回本地列表。
   * 后端现在会连缓存元信息一起回传，必须一并写回 —— 否则前端保存时的整表覆盖
   * 会把后端刚写入的 cachedRaw 抹掉，「实时拉取」关闭后就没有兜底数据了。
   */
  function applyBatchResults(results) {
    (results || []).forEach(r => {
      if (!r || !r.success) return;
      const sub = subscriptions.value.find(s => s.id === r.id);
      if (!sub) return;
      sub.nodeCount = r.nodeCount ?? sub.nodeCount;
      if (r.userInfo) sub.userInfo = r.userInfo;
      if (typeof r.cachedRaw === 'string') sub.cachedRaw = r.cachedRaw;
      if (typeof r.cachedAt !== 'undefined' && r.cachedAt !== null) sub.cachedAt = r.cachedAt;
      if (typeof r.cachedFromUrl !== 'undefined' && r.cachedFromUrl !== null) sub.cachedFromUrl = r.cachedFromUrl;
      if (typeof r.cachedRawPresent !== 'undefined') sub.cachedRawPresent = !!r.cachedRawPresent;
    });
  }

  /**
   * 一键刷新全部启用的机场订阅。
   * Cloudflare Pages Functions 不支持 cron 触发（wrangler.toml 里的 [triggers]
   * 对 Pages 项目无效），所以流量/到期信息不会自动刷新 —— 这里提供一个手动入口。
   */
  async function refreshAllSubscriptions() {
    const targets = subscriptions.value.filter(s => s.enabled && s.url && s.url.startsWith('http'));
    if (targets.length === 0) {
      showToast('没有已启用的机场订阅需要刷新', 'info');
      return;
    }
    targets.forEach(s => { s.isUpdating = true; });
    showToast(`正在刷新 ${targets.length} 个订阅的流量与节点数...`, 'info');
    try {
      const result = await batchUpdateNodes(targets.map(s => s.id));
      if (result.success) {
        applyBatchResults(result.results);
        markDirty();
        showToast(result.message || '刷新完成，请点击保存更改', 'success');
      } else {
        showToast(result.message || '刷新失败', 'error');
      }
    } catch (e) {
      console.error('refreshAllSubscriptions failed:', e);
      showToast('刷新失败，请检查网络后重试', 'error');
    } finally {
      targets.forEach(s => { s.isUpdating = false; });
    }
  }

  // {{ AURA-X: Modify - 使用批量更新API优化批量导入. Approval: 寸止(ID:1735459200). }}
  // [优化] 批量導入使用批量更新API，减少KV写入次数
  async function addSubscriptionsFromBulk(subs) {
    subscriptions.value.unshift(...subs);
    markDirty();

    // 过滤出需要更新的订阅（只有http/https链接）
    const subsToUpdate = subs.filter(sub => sub.url && sub.url.startsWith('http'));

    if (subsToUpdate.length > 0) {
      showToast(`正在批量更新 ${subsToUpdate.length} 个订阅...`, 'success');

      try {
        const result = await batchUpdateNodes(subsToUpdate.map(sub => sub.id));

        if (result.success) {
          applyBatchResults(result.results);
          const successCount = (result.results || []).filter(r => r.success).length;
          showToast(`批量更新完成！成功更新 ${successCount}/${subsToUpdate.length} 个订阅`, 'success');
          markDirty(); // 标记需要保存
        } else {
          showToast(`批量更新失败: ${result.message}`, 'error');
          // 降级到逐个更新
          showToast('正在降级到逐个更新模式...', 'info');
          for (const sub of subsToUpdate) {
            await handleUpdateNodeCount(sub.id);
          }
        }
      } catch (error) {
        console.error('Batch update failed:', error);
        showToast('批量更新失败，正在降级到逐个更新...', 'error');
        // 降级到逐个更新
        for (const sub of subsToUpdate) {
          await handleUpdateNodeCount(sub.id);
        }
      }
    } else {
      showToast('批量导入完成！', 'success');
    }
  }

  watch(initialSubsRef, (newInitialSubs) => {
    initializeSubscriptions(newInitialSubs);
  }, { immediate: true, deep: true });

  return {
    subscriptions,
    subsCurrentPage,
    subsTotalPages,
    paginatedSubscriptions,
    totalRemainingTraffic,
    enabledSubscriptionsCount: computed(() => enabledSubscriptions.value.length),
    changeSubsPage,
    addSubscription,
    updateSubscription,
    deleteSubscription,
    deleteAllSubscriptions,
    addSubscriptionsFromBulk,
    handleUpdateNodeCount,
    refreshAllSubscriptions,
  };
}