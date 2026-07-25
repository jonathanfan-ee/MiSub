<script setup>
import { ref, computed, onMounted, onUnmounted, defineAsyncComponent } from 'vue';
import { saveMisubs } from '../lib/api.js';
import { extractNodeName } from '../lib/utils.js';
import { useToastStore } from '../stores/toast.js';
import { useUIStore } from '../stores/ui.js';
import { useSubscriptions } from '../composables/useSubscriptions.js';
import { useManualNodes } from '../composables/useManualNodes.js';
import { useProfiles } from '../composables/useProfiles.js';

// --- Component Imports ---
import RightPanel from './RightPanel.vue';
import ProfilePanel from './ProfilePanel.vue';
import SubscriptionPanel from './SubscriptionPanel.vue';
import ManualNodePanel from './ManualNodePanel.vue';
import Modal from './Modal.vue';
import UnifiedSortModal from './UnifiedSortModal.vue';

const SettingsModal = defineAsyncComponent(() => import('./SettingsModal.vue'));
const BulkImportModal = defineAsyncComponent(() => import('./BulkImportModal.vue'));
const ProfileModal = defineAsyncComponent(() => import('./ProfileModal.vue'));
const SubscriptionImportModal = defineAsyncComponent(() => import('./SubscriptionImportModal.vue'));

// --- 基礎 Props 和狀態 ---
const props = defineProps({ data: Object });
const { showToast } = useToastStore();
const uiStore = useUIStore();
const isLoading = ref(true);
const dirty = ref(false);
const saveState = ref('idle');

// --- 將狀態和邏輯委託給 Composables ---
// dirtyRevision 每次改动自增，用来判断「保存完成后的延迟重置」期间是否又有新改动
const dirtyRevision = ref(0);
let saveResetTimer = null;

// --- 自动保存 / 撤销 ---
// 每次改动都要手动点「保存更改」确实麻烦，但手动保存的好处是误操作可以不保存。
// 这里的取舍：自动保存默认关闭（保持原有的安全感），想省事的人可以打开；
// 同时提供「撤销」，这样即使开了自动保存，误操作依然可以退回上一步。
const autoSaveEnabled = ref(false);
const AUTO_SAVE_DELAY = 2500;
let autoSaveTimer = null;
const lastSavedAt = ref(null);

// 撤销历史。快照里剔除 cachedRaw（那是服务端缓存的订阅原文，可能几十 KB，
// 存进历史会吃掉大量内存），撤销时再从当前数据按 id 合并回来。
const MAX_HISTORY = 20;
const history = ref([]);
let lastSnapshot = null;

const stripCache = (list) => (list || []).map(({ cachedRaw, ...rest }) => rest);

const takeSnapshot = () => ({
  subscriptions: stripCache(subscriptions.value),
  manualNodes: stripCache(manualNodes.value),
  profiles: JSON.parse(JSON.stringify(profiles.value || [])),
  unifiedOrderIds: unifiedOrderIds.value ? [...unifiedOrderIds.value] : null,
});

const canUndo = computed(() => history.value.length > 0);

const markDirty = () => {
  // markDirty 在修改「之后」触发，所以此刻 lastSnapshot 保存的正是修改前的状态
  if (lastSnapshot) {
    history.value.push(lastSnapshot);
    if (history.value.length > MAX_HISTORY) history.value.shift();
  }
  lastSnapshot = takeSnapshot();

  dirty.value = true;
  dirtyRevision.value++;
  saveState.value = 'idle';

  if (autoSaveEnabled.value) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => { if (dirty.value) handleSave(); }, AUTO_SAVE_DELAY);
  }
};

const initialSubs = ref([]);
const initialNodes = ref([]);

const {
  subscriptions, subsCurrentPage, subsTotalPages, paginatedSubscriptions, totalRemainingTraffic,
  changeSubsPage, addSubscription, updateSubscription, deleteSubscription, deleteAllSubscriptions,
  addSubscriptionsFromBulk, handleUpdateNodeCount, refreshAllSubscriptions,
} = useSubscriptions(initialSubs, markDirty);

const {
  manualNodes, manualNodesCurrentPage, manualNodesTotalPages, paginatedManualNodes,
  filteredManualNodes, searchTerm,
  changeManualNodesPage, setManualNodes, addNode, updateNode, deleteNode, deleteAllNodes,
  addNodesFromBulk, autoSortNodes, deduplicateNodes,
} = useManualNodes(initialNodes, markDirty);

// --- 訂閱組 (Profile) 相關狀態 ---
const config = ref({});
const initialProfiles = ref([]);
const {
  profiles, editingProfile, isNewProfile, showProfileModal, showDeleteProfilesModal,
  initializeProfiles, handleProfileToggle, handleAddProfile, handleEditProfile,
  handleSaveProfile, handleDeleteProfile, handleDeleteAllProfiles, copyProfileLink,
  cleanupSubscriptions, cleanupNodes, cleanupAllSubscriptions, cleanupAllNodes,
} = useProfiles(initialProfiles, markDirty, config);

// --- 单项删除的二次确认 ---
// 之前单个订阅 / 手动节点 / 订阅组的删除按钮点一下就直接删了，没有任何确认。
// 订阅组尤其危险：删掉之后已经发给客户的订阅链接立刻失效。
const pendingDelete = ref(null); // { kind: 'sub'|'node'|'profile', id, name }
const showDeleteItemModal = ref(false);

const deleteKindLabel = { sub: '机场订阅', node: '手动节点', profile: '订阅组' };

const requestDelete = (kind, id) => {
  const source = kind === 'sub' ? subscriptions.value : kind === 'node' ? manualNodes.value : profiles.value;
  const item = source.find(i => i.id === id);
  pendingDelete.value = { kind, id, name: item?.name || '（未命名）' };
  showDeleteItemModal.value = true;
};

const confirmDelete = () => {
  const target = pendingDelete.value;
  if (!target) return;
  if (target.kind === 'sub') {
    deleteSubscription(target.id);
    cleanupSubscriptions(target.id);
  } else if (target.kind === 'node') {
    deleteNode(target.id);
    cleanupNodes(target.id);
  } else {
    handleDeleteProfile(target.id);
  }
  showToast(`已删除${deleteKindLabel[target.kind]}「${target.name}」，请记得保存`, 'success');
  pendingDelete.value = null;
};

// --- UI State ---
const isSortingSubs = ref(false);
const isSortingNodes = ref(false);
const manualNodeViewMode = ref('card');
const editingSubscription = ref(null);
const isNewSubscription = ref(false);
const showSubModal = ref(false);
const editingNode = ref(null);
const isNewNode = ref(false);
const showNodeModal = ref(false);
const showBulkImportModal = ref(false);
const showDeleteSubsModal = ref(false);
const showDeleteNodesModal = ref(false);
const showSubscriptionImportModal = ref(false);
const showUnifiedSortModal = ref(false);
const unifiedOrderIds = ref(null);
// --- 初始化與生命週期 ---
const initializeState = () => {
  isLoading.value = true;
  if (props.data) {
    const subsData = props.data.misubs || [];
    unifiedOrderIds.value = subsData.map(item => item.id).filter(Boolean);
    initialSubs.value = subsData.filter(item => item.url && /^https?:\/\//.test(item.url));
    initialNodes.value = subsData.filter(item => !item.url || !/^https?:\/\//.test(item.url));
    initialProfiles.value = props.data.profiles || [];
    config.value = props.data.config || {};
    initializeProfiles();
  }
  isLoading.value = false;
  dirty.value = false;
  // 重置撤销历史，并把当前状态记为基线
  history.value = [];
  lastSnapshot = takeSnapshot();
};

const handleBeforeUnload = (event) => {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = '您有未保存的更改，確定要离开嗎？';
  }
};

onMounted(() => {
  initializeState();
  window.addEventListener('beforeunload', handleBeforeUnload);
  window.addEventListener('keydown', handleGlobalKeydown);
  const savedViewMode = localStorage.getItem('manualNodeViewMode');
  if (savedViewMode) {
    manualNodeViewMode.value = savedViewMode;
  }
  autoSaveEnabled.value = localStorage.getItem('misubAutoSave') === '1';
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload);
  window.removeEventListener('keydown', handleGlobalKeydown);
  clearTimeout(autoSaveTimer);
  clearTimeout(saveResetTimer);
});

const setViewMode = (mode) => {
  manualNodeViewMode.value = mode;
  localStorage.setItem('manualNodeViewMode', mode);
};

// --- 其他 JS 逻辑 (省略) ---
const handleDiscard = () => {
  initializeState();
  showToast('已放弃所有未保存的更改');
};
const handleSave = async () => {
  saveState.value = 'saving';
  const subMap = new Map(subscriptions.value.map(s => [s.id, { ...s, isUpdating: undefined }]));
  const nodeMap = new Map(manualNodes.value.map(n => [n.id, { ...n, isUpdating: undefined }]));
  let combinedMisubs = [];
  // 组合保存顺序。
  // 关键点：unifiedOrderIds 只描述「订阅与手动节点如何交错」，
  // 每一类内部的相对顺序必须以当前数组为准 —— 拖拽排序和一键排序改的正是数组本身。
  // 之前直接按 unifiedOrderIds 逐个取出，等于把加载时的旧顺序重新写回去，
  // 于是拖动排序 / 一键排序永远保存不上（界面上却提示「保存成功」）。
  if (unifiedOrderIds.value && unifiedOrderIds.value.length) {
    const subOrder = subscriptions.value.map(s => s.id);
    const nodeOrder = manualNodes.value.map(n => n.id);
    let subCursor = 0;
    let nodeCursor = 0;
    const used = new Set();
    // 沿用已保存的「类别交错模式」，但每个槽位填入当前数组里的下一项
    for (const id of unifiedOrderIds.value) {
      if (subMap.has(id)) {
        while (subCursor < subOrder.length && used.has(subOrder[subCursor])) subCursor++;
        if (subCursor < subOrder.length) {
          const pick = subOrder[subCursor++];
          used.add(pick);
          combinedMisubs.push(subMap.get(pick));
        }
      } else if (nodeMap.has(id)) {
        while (nodeCursor < nodeOrder.length && used.has(nodeOrder[nodeCursor])) nodeCursor++;
        if (nodeCursor < nodeOrder.length) {
          const pick = nodeOrder[nodeCursor++];
          used.add(pick);
          combinedMisubs.push(nodeMap.get(pick));
        }
      }
    }
    // 追加遗漏项（新建等），保持各自数组内的顺序
    subOrder.forEach(id => { if (!used.has(id)) { used.add(id); combinedMisubs.push(subMap.get(id)); } });
    nodeOrder.forEach(id => { if (!used.has(id)) { used.add(id); combinedMisubs.push(nodeMap.get(id)); } });
  } else {
    const subsArr = Array.from(subMap.values());
    const nodesArr = Array.from(nodeMap.values());
    combinedMisubs = (config.value.manualNodesPosition === 'after')
      ? [...subsArr, ...nodesArr]
      : [...nodesArr, ...subsArr];
  }
  // 保存的顺序即新的权威顺序，写回本地以便后续保存不再参照过期数据
  unifiedOrderIds.value = combinedMisubs.map(i => i.id).filter(Boolean);

  try {
    // 数据验证
    if (!Array.isArray(combinedMisubs) || !Array.isArray(profiles.value)) {
      throw new Error('数据格式错误，请刷新页面后重试');
    }

    const result = await saveMisubs(combinedMisubs, profiles.value);

    if (result.success) {
        saveState.value = 'success';
        lastSavedAt.value = new Date();
        // 自动保存时用更轻的提示，避免每隔几秒就弹一次「保存成功」
        if (!autoSaveEnabled.value) showToast('保存成功！', 'success');
        // 记下本次保存对应的修改序号：如果在这 1.5 秒内用户又改了东西，
        // 就不能把 dirty 清掉，否则那些改动会被静默丢弃。
        const savedRevision = dirtyRevision.value;
        clearTimeout(saveResetTimer);
        saveResetTimer = setTimeout(() => {
          if (dirtyRevision.value === savedRevision) dirty.value = false;
          saveState.value = 'idle';
        }, 1500);
    } else {
        // 显示服务器返回的具体错误信息
        const errorMessage = result.message || result.error || '保存失败，请稍后重试';
        throw new Error(errorMessage);
    }
  } catch (error) {
    console.error('保存数据时发生错误:', error);

    // 根据错误类型提供不同的用户提示
    let userMessage = error.message;
    if (error.message.includes('网络')) {
      userMessage = '网络连接异常，请检查网络后重试';
    } else if (error.message.includes('格式')) {
      userMessage = '数据格式异常，请刷新页面后重试';
    } else if (error.message.includes('存储')) {
      userMessage = '存储服务暂时不可用，请稍后重试';
    }

    showToast(userMessage, 'error');
    saveState.value = 'idle';
  }
};
const handleDeleteAllSubscriptionsWithCleanup = () => {
  deleteAllSubscriptions();
  cleanupAllSubscriptions();
  showDeleteSubsModal.value = false;
};
const handleDeleteAllNodesWithCleanup = () => {
  deleteAllNodes();
  cleanupAllNodes();
  showDeleteNodesModal.value = false;
};
// 一键排序改为「只标记待保存」，与一键去重保持一致。
// 之前它会立刻调用 handleSave()，把用户其它还没想好的改动一起提交上去，且无法撤销。
const handleAutoSortNodes = () => {
  autoSortNodes();
  showToast('已按地区排序，请点击“保存更改”生效', 'success');
};

const handleDeduplicateNodes = () => {
    deduplicateNodes();
    showToast('已完成去重，请手动保存', 'success');
};

const handleRefreshAll = () => refreshAllSubscriptions();

/** 撤销上一步改动（Ctrl/⌘ + Z）。 */
const handleUndo = () => {
  const snapshot = history.value.pop();
  if (!snapshot) return;

  // 把当前的 cachedRaw 按 id 合并回去（快照里刻意没存这个大字段）
  const cacheBySubId = new Map(subscriptions.value.map(s => [s.id, s.cachedRaw]));
  const cacheByNodeId = new Map(manualNodes.value.map(n => [n.id, n.cachedRaw]));

  subscriptions.value = snapshot.subscriptions.map(s => ({ ...s, cachedRaw: cacheBySubId.get(s.id) ?? '' }));
  setManualNodes(snapshot.manualNodes.map(n => ({ ...n, cachedRaw: cacheByNodeId.get(n.id) ?? '' })));
  profiles.value = JSON.parse(JSON.stringify(snapshot.profiles));
  unifiedOrderIds.value = snapshot.unifiedOrderIds ? [...snapshot.unifiedOrderIds] : null;

  // setManualNodes 内部会调用 markDirty，那会把刚撤销的状态又压回历史，这里修正掉
  history.value.pop();
  lastSnapshot = takeSnapshot();
  dirty.value = true;
  dirtyRevision.value++;

  showToast(autoSaveEnabled.value ? '已撤销，正在自动保存...' : '已撤销上一步，请点击“保存更改”', 'success');
  if (autoSaveEnabled.value) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => { if (dirty.value) handleSave(); }, AUTO_SAVE_DELAY);
  }
};

const toggleAutoSave = () => {
  autoSaveEnabled.value = !autoSaveEnabled.value;
  localStorage.setItem('misubAutoSave', autoSaveEnabled.value ? '1' : '0');
  if (autoSaveEnabled.value) {
    showToast('已开启自动保存：改动会在停止操作约 2.5 秒后自动提交，可用「撤销」回退', 'success');
    if (dirty.value) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => { if (dirty.value) handleSave(); }, AUTO_SAVE_DELAY);
    }
  } else {
    clearTimeout(autoSaveTimer);
    showToast('已关闭自动保存，改动需要手动点击“保存更改”', 'info');
  }
};

// 全局快捷键：Ctrl/⌘+S 保存、Ctrl/⌘+Z 撤销
const handleGlobalKeydown = (e) => {
  const meta = e.ctrlKey || e.metaKey;
  if (!meta) return;
  const key = e.key.toLowerCase();
  if (key === 's') {
    e.preventDefault(); // 阻止浏览器的「保存网页」
    if (dirty.value && saveState.value === 'idle') handleSave();
  } else if (key === 'z' && !e.shiftKey) {
    // 输入框内的 Ctrl+Z 交给浏览器做文本撤销
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (canUndo.value) {
      e.preventDefault();
      handleUndo();
    }
  }
};

// --- Backup & Restore ---
const exportBackup = () => {
  try {
    const backupData = {
      subscriptions: subscriptions.value,
      manualNodes: manualNodes.value,
      profiles: profiles.value,
    };

    const jsonString = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    a.download = `misub-backup-${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('备份已成功导出', 'success');
  } catch (error) {
    console.error('Backup export failed:', error);
    showToast('备份导出失败', 'error');
  }
};

// 备份恢复：先读文件并解析，再用本站弹窗做确认（不再用原生 confirm）
const pendingRestore = ref(null);
const showRestoreModal = ref(false);

const importBackup = () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';

  input.onchange = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data || !Array.isArray(data.subscriptions) || !Array.isArray(data.manualNodes) || !Array.isArray(data.profiles)) {
          throw new Error('无效的备份文件格式');
        }
        pendingRestore.value = data;
        showRestoreModal.value = true;
      } catch (error) {
        console.error('Backup import failed:', error);
        showToast(`备份导入失败: ${error.message}`, 'error');
      }
    };
    reader.onerror = () => showToast('读取备份文件失败', 'error');
    reader.readAsText(file);
  };
  input.click();
};

const confirmRestore = () => {
  const data = pendingRestore.value;
  if (!data) return;
  subscriptions.value = data.subscriptions;
  // 必须走 setManualNodes：manualNodes 以前是只读 computed，
  // 直接 manualNodes.value = ... 只会在控制台 warn，手动节点被静默丢弃。
  setManualNodes(data.manualNodes);
  profiles.value = data.profiles;
  // 备份里的顺序即为恢复后的顺序，清空旧的交错模式让它按数组顺序保存
  unifiedOrderIds.value = null;
  markDirty();
  showToast(`已恢复 ${data.subscriptions.length} 条订阅、${data.manualNodes.length} 个节点、${data.profiles.length} 个订阅组，请点击“保存更改”`, 'success');
  pendingRestore.value = null;
  uiStore.hide(); // Close settings modal after import
};
const handleBulkImport = (importText) => {
  if (!importText) return;
  const lines = importText.split('\n').map(line => line.trim()).filter(Boolean);
  const newSubs = [], newNodes = [];
  let unrecognized = 0;
  for (const line of lines) {
      const newItem = { id: crypto.randomUUID(), name: extractNodeName(line) || '未命名', url: line, enabled: true, status: 'unchecked' };
      if (/^https?:\/\//.test(line)) {
          // 与后端默认值保持一致：机场订阅默认开启实时拉取
          newSubs.push({ ...newItem, realtimeFetch: true, nodeCount: 0, isUpdating: false, userInfo: null, exclude: '' });
      } else if (/^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//i.test(line)) {
          newNodes.push(newItem);
      } else {
          unrecognized++;
      }
  }
  if (newSubs.length > 0) addSubscriptionsFromBulk(newSubs);
  if (newNodes.length > 0) addNodesFromBulk(newNodes);
  if (newSubs.length === 0 && newNodes.length === 0) {
    showToast('没有识别出任何订阅或节点，请检查粘贴的内容', 'error');
    return;
  }
  // 明确告知有多少行被忽略，而不是让用户自己发现数量不对
  const skippedNote = unrecognized > 0 ? `，忽略 ${unrecognized} 行无法识别的内容` : '';
  showToast(`成功导入 ${newSubs.length} 条订阅和 ${newNodes.length} 个手动节点${skippedNote}，请点击保存`, 'success');
};
const handleAddSubscription = () => {
  isNewSubscription.value = true;
  // 补齐默认值：之前新建的订阅没有 realtimeFetch，卡片上「实时」开关显示为关，
  // 而后端把 undefined 当成开启，界面和实际行为不一致。
  editingSubscription.value = { name: '', url: '', enabled: true, exclude: '', realtimeFetch: true, nodeCount: 0, isUpdating: false, userInfo: null };
  showSubModal.value = true;
};
const handleEditSubscription = (subId) => {
  const sub = subscriptions.value.find(s => s.id === subId);
  if (sub) {
    isNewSubscription.value = false;
    editingSubscription.value = { ...sub };
    showSubModal.value = true;
  }
};
// 校验错误改为弹窗内的常驻内联提示：Modal 现在不会在 confirm 时自动关闭，
// 用户能看到错误、也不会丢掉已经填好的内容。
const subFormError = ref('');
const nodeFormError = ref('');

const handleSaveSubscription = () => {
  subFormError.value = '';
  const sub = editingSubscription.value;
  if (!sub || !sub.url || !sub.url.trim()) { subFormError.value = '订阅链接不能为空'; return; }
  if (!/^https?:\/\//.test(sub.url.trim())) { subFormError.value = '请输入有效的 http:// 或 https:// 订阅链接'; return; }
  sub.url = sub.url.trim();

  if (isNewSubscription.value) {
    addSubscription({ ...sub, id: crypto.randomUUID() });
  } else {
    updateSubscription(sub);
  }
  showSubModal.value = false;
};
const handleAddNode = () => {
  isNewNode.value = true;
  editingNode.value = { id: crypto.randomUUID(), name: '', url: '', enabled: true };
  showNodeModal.value = true;
};
const handleEditNode = (nodeId) => {
  const node = manualNodes.value.find(n => n.id === nodeId);
  if (node) {
    isNewNode.value = false;
    editingNode.value = { ...node };
    showNodeModal.value = true;
  }
};
const handleNodeUrlInput = (event) => {
  if (!editingNode.value) return;
  const newUrl = event.target.value;
  if (newUrl && !editingNode.value.name) {
    editingNode.value.name = extractNodeName(newUrl);
  }
};

// 订阅链接输入时先用主机名占位。
// 「不填将自动获取」以前对订阅完全没有实现（只有手动节点做了），
// 保存后卡片上只会显示「未命名订阅」。现在：这里先填主机名，
// 随后 /api/node_count 拿到机场声明的 profile-title 时再替换成正式名称。
const handleSubUrlInput = (event) => {
  if (!editingSubscription.value) return;
  const newUrl = (event.target.value || '').trim();
  if (!newUrl || editingSubscription.value.name) return;
  try {
    editingSubscription.value.name = new URL(newUrl).hostname;
  } catch {
    // 地址还没输完，等下一次输入
  }
};
const NODE_LINK_RE = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy2?|tuic|anytls|socks5):\/\//i;

const handleSaveNode = () => {
    nodeFormError.value = '';
    const node = editingNode.value;
    if (!node || !node.url || !node.url.trim()) { nodeFormError.value = '节点链接不能为空'; return; }
    node.url = node.url.trim();
    // 提前拦住格式不对的链接：以前可以存进去，但聚合时会被静默过滤，
    // 用户只会发现「节点少了」，完全不知道原因。
    if (!NODE_LINK_RE.test(node.url)) {
        nodeFormError.value = '节点链接格式不正确，需以 ss:// vmess:// vless:// trojan:// hysteria2:// tuic:// anytls:// socks5:// 等开头';
        return;
    }
    if (!node.name) node.name = extractNodeName(node.url) || '未命名节点';
    if (isNewNode.value) {
        addNode(node);
    } else {
        updateNode(node);
    }
    showNodeModal.value = false;
};

const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes || bytes < 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  if (i < 0) return '0 B';
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};
const formattedTotalRemainingTraffic = computed(() => formatBytes(totalRemainingTraffic.value));

</script>

<template>
  <div v-if="isLoading" class="text-center py-16 text-gray-500">
    正在加载...
  </div>
  <div v-else class="w-full max-w-(--breakpoint-xl) mx-auto p-4 sm:p-6 lg:p-8">
    <!-- Header -->
    <div class="flex justify-between items-center mb-8">
      <div class="flex items-center gap-4">
        <h1 class="text-2xl font-bold text-gray-800 dark:text-white">仪表盘</h1>
        <span 
          v-if="formattedTotalRemainingTraffic !== '0 B'"
          class="px-3 py-1 text-sm font-semibold text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-500/20 rounded-full"
        >
          剩余总流量: {{ formattedTotalRemainingTraffic }}
        </span>
      </div>
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <button @click="handleRefreshAll" class="text-sm font-semibold px-4 py-2 rounded-lg text-sky-600 dark:text-sky-300 border-2 border-sky-500/50 hover:bg-sky-500/10 transition-colors" title="重新拉取所有已启用机场订阅的流量与节点数">刷新全部</button>
        <button @click="showUnifiedSortModal = true" class="text-sm font-semibold px-4 py-2 rounded-lg text-teal-600 dark:text-teal-300 border-2 border-teal-500/50 hover:bg-teal-500/10 transition-colors">统一排序</button>
        <button @click="showBulkImportModal = true" class="text-sm font-semibold px-4 py-2 rounded-lg text-indigo-600 dark:text-indigo-400 border-2 border-indigo-500/50 hover:bg-indigo-500/10 transition-colors">批量导入</button>
      </div>
    </div>

    <!-- 保存状态栏：未保存时显示操作按钮，已保存时只显示一行淡淡的状态 -->
    <Transition name="slide-fade">
      <div v-if="dirty" class="p-3 mb-6 rounded-lg bg-indigo-600/10 dark:bg-indigo-500/20 ring-1 ring-inset ring-indigo-600/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-center gap-2 flex-wrap">
          <p class="text-sm font-medium text-indigo-800 dark:text-indigo-200">
            {{ autoSaveEnabled ? (saveState === 'saving' ? '正在自动保存...' : '改动将在稍后自动保存') : '您有未保存的更改' }}
          </p>
          <span class="hidden md:inline text-xs text-indigo-700/60 dark:text-indigo-300/60">
            {{ autoSaveEnabled ? '（⌘/Ctrl+Z 撤销）' : '（⌘/Ctrl+S 保存，⌘/Ctrl+Z 撤销）' }}
          </span>
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <button @click="toggleAutoSave" class="inline-btn text-xs font-medium px-2.5 py-1 rounded-full transition-colors"
                  :class="autoSaveEnabled ? 'bg-teal-500/20 text-teal-700 dark:text-teal-300' : 'bg-gray-500/10 text-gray-600 dark:text-gray-400 hover:bg-gray-500/20'"
                  :title="autoSaveEnabled ? '点击关闭自动保存' : '点击开启自动保存（停止操作约 2.5 秒后提交）'">
            自动保存：{{ autoSaveEnabled ? '开' : '关' }}
          </button>
          <button @click="handleUndo" :disabled="!canUndo" class="text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white" title="撤销上一步 (⌘/Ctrl+Z)">撤销</button>
          <button @click="handleDiscard" class="text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors">放弃更改</button>
          <button @click="handleSave" :disabled="saveState !== 'idle'" class="px-5 py-2 text-sm text-white font-semibold rounded-lg shadow-xs flex items-center justify-center transition-all duration-300 w-28" :class="{'bg-indigo-600 hover:bg-indigo-700': saveState === 'idle', 'bg-gray-500 cursor-not-allowed': saveState === 'saving', 'bg-teal-500 cursor-not-allowed': saveState === 'success' }">
            <div v-if="saveState === 'saving'" class="flex items-center"><svg class="animate-spin h-5 w-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>保存中...</span></div>
            <div v-else-if="saveState === 'success'" class="flex items-center"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg><span>已保存</span></div>
            <span v-else>保存更改</span>
          </button>
        </div>
      </div>
      <!-- 没有未保存改动时，用一行很轻的状态说明当前模式，避免用户搞不清有没有保存 -->
      <div v-else-if="lastSavedAt || autoSaveEnabled" class="px-1 mb-6 flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500">
        <span v-if="lastSavedAt">已保存于 {{ lastSavedAt.toLocaleTimeString() }}</span>
        <button @click="toggleAutoSave" class="inline-btn underline hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
          自动保存：{{ autoSaveEnabled ? '开' : '关' }}
        </button>
      </div>
    </Transition>

    <!-- Main Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8 items-start">
      <div class="lg:col-span-2 md:col-span-2 space-y-12">
        <!-- Subscription Panel -->
        <SubscriptionPanel
          :subscriptions="subscriptions"
          :paginated-subscriptions="paginatedSubscriptions"
          :current-page="subsCurrentPage"
          :total-pages="subsTotalPages"
          :is-sorting="isSortingSubs"
          @add="handleAddSubscription"
          @delete="(id) => requestDelete('sub', id)"
          @change-page="changeSubsPage"
          @update-node-count="handleUpdateNodeCount"
          @edit="handleEditSubscription"
          @toggle-sort="isSortingSubs = !isSortingSubs"
          @mark-dirty="markDirty"
          @delete-all="showDeleteSubsModal = true"
        />

        <!-- Manual Node Panel -->
        <ManualNodePanel
          :manual-nodes="manualNodes"
          :paginated-manual-nodes="paginatedManualNodes"
          :filtered-count="filteredManualNodes.length"
          :current-page="manualNodesCurrentPage"
          :total-pages="manualNodesTotalPages"
          :is-sorting="isSortingNodes"
          :search-term="searchTerm"
          :view-mode="manualNodeViewMode"
          @add="handleAddNode"
          @delete="(id) => requestDelete('node', id)"
          @edit="handleEditNode"
          @change-page="changeManualNodesPage"
          @update:search-term="newVal => { searchTerm = newVal }"
          @update:view-mode="setViewMode"
          @toggle-sort="isSortingNodes = !isSortingNodes"
          @mark-dirty="markDirty"
          @auto-sort="handleAutoSortNodes"
          @deduplicate="handleDeduplicateNodes"
          @import="showSubscriptionImportModal = true"
          @delete-all="showDeleteNodesModal = true"
        />
      </div>
      
      <!-- Right Column -->
      <div class="lg:col-span-1 space-y-8">
        <RightPanel :config="config" :profiles="profiles" />
        <ProfilePanel
          :profiles="profiles"
          @add="handleAddProfile"
          @edit="handleEditProfile"
          @delete="(id) => requestDelete('profile', id)"
          @deleteAll="showDeleteProfilesModal = true"
          @toggle="handleProfileToggle"
          @copyLink="copyProfileLink"
        />
      </div>
    </div>
  </div>

  <BulkImportModal v-model:show="showBulkImportModal" @import="handleBulkImport" />
  <Modal v-model:show="showDeleteSubsModal" @confirm="handleDeleteAllSubscriptionsWithCleanup" danger confirm-text="全部删除">
    <template #title><h3 class="text-lg font-bold text-red-500">确认清空订阅</h3></template>
    <template #body><p class="text-sm text-gray-600 dark:text-gray-300">将删除全部 <strong>{{ subscriptions.length }}</strong> 条机场订阅。此操作会标记为待保存，不会影响手动节点。</p></template>
  </Modal>
  <Modal v-model:show="showDeleteNodesModal" @confirm="handleDeleteAllNodesWithCleanup" danger confirm-text="全部删除">
    <template #title><h3 class="text-lg font-bold text-red-500">确认清空节点</h3></template>
    <template #body><p class="text-sm text-gray-600 dark:text-gray-300">将删除全部 <strong>{{ manualNodes.length }}</strong> 个手动节点。此操作会标记为待保存，不会影响机场订阅。</p></template>
  </Modal>
  <Modal v-model:show="showDeleteProfilesModal" @confirm="handleDeleteAllProfiles" danger confirm-text="全部删除">
    <template #title><h3 class="text-lg font-bold text-red-500">确认清空订阅组</h3></template>
    <template #body><p class="text-sm text-gray-600 dark:text-gray-300">将删除全部 <strong>{{ profiles.length }}</strong> 个订阅组。<strong class="text-red-500">已经分发出去的订阅组链接会立即失效。</strong></p></template>
  </Modal>

  <!-- 单项删除确认 -->
  <Modal v-model:show="showDeleteItemModal" @confirm="confirmDelete" danger confirm-text="删除">
    <template #title><h3 class="text-lg font-bold text-red-500">确认删除</h3></template>
    <template #body>
      <p class="text-sm text-gray-600 dark:text-gray-300">
        确定要删除{{ deleteKindLabel[pendingDelete?.kind] || '这一项' }}
        <strong class="text-gray-900 dark:text-white">「{{ pendingDelete?.name }}」</strong>吗？
      </p>
      <p v-if="pendingDelete?.kind === 'profile'" class="text-xs text-red-500 mt-2">
        该订阅组已经分发出去的订阅链接会立即失效。
      </p>
      <p v-else class="text-xs text-gray-400 mt-2">此操作会标记为待保存，点击“保存更改”后生效。</p>
    </template>
  </Modal>

  <!-- 备份恢复确认 -->
  <Modal v-model:show="showRestoreModal" @confirm="confirmRestore" danger confirm-text="覆盖并恢复">
    <template #title><h3 class="text-lg font-bold text-red-500">确认从备份恢复</h3></template>
    <template #body>
      <p class="text-sm text-gray-600 dark:text-gray-300">这会用备份文件的内容覆盖当前全部数据：</p>
      <div class="mt-3 text-sm font-mono bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3 space-y-1">
        <div>机场订阅：{{ subscriptions.length }} → <strong>{{ pendingRestore?.subscriptions?.length ?? 0 }}</strong></div>
        <div>手动节点：{{ manualNodes.length }} → <strong>{{ pendingRestore?.manualNodes?.length ?? 0 }}</strong></div>
        <div>订阅组：{{ profiles.length }} → <strong>{{ pendingRestore?.profiles?.length ?? 0 }}</strong></div>
      </div>
      <p class="text-xs text-gray-400 mt-2">恢复后仍需点击“保存更改”才会写入服务器。</p>
    </template>
  </Modal>

  <ProfileModal v-if="showProfileModal" v-model:show="showProfileModal" :profile="editingProfile" :is-new="isNewProfile" :all-subscriptions="subscriptions" :all-manual-nodes="manualNodes" @save="handleSaveProfile" size="2xl" />
  
  <Modal v-if="editingNode" v-model:show="showNodeModal" @confirm="handleSaveNode" :close-on-confirm="false" size="lg" :confirm-text="isNewNode ? '添加' : '保存'">
    <template #title><h3 class="text-lg font-bold text-gray-800 dark:text-white">{{ isNewNode ? '新增手动节点' : '编辑手动节点' }}</h3></template>
    <template #body>
      <div class="space-y-4">
        <div><label for="node-name" class="block text-sm font-medium text-gray-700 dark:text-gray-300">节点名称</label><input type="text" id="node-name" v-model="editingNode.name" placeholder="（可选）不填将自动获取" class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white"></div>
        <div>
          <label for="node-url" class="block text-sm font-medium text-gray-700 dark:text-gray-300">节点链接</label>
          <textarea id="node-url" v-model="editingNode.url" @input="handleNodeUrlInput" rows="4" placeholder="vmess:// vless:// trojan:// ss:// hysteria2:// tuic:// ..." class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm font-mono dark:text-white" :class="nodeFormError ? 'border-red-500 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'"></textarea>
          <p class="text-xs text-gray-400 mt-1">按 Ctrl/⌘ + Enter 快速保存。</p>
        </div>
        <p v-if="nodeFormError" class="text-sm text-red-500">{{ nodeFormError }}</p>
      </div>
    </template>
  </Modal>

  <Modal v-if="editingSubscription" v-model:show="showSubModal" @confirm="handleSaveSubscription" :close-on-confirm="false" size="lg" :confirm-text="isNewSubscription ? '添加' : '保存'">
    <template #title><h3 class="text-lg font-bold text-gray-800 dark:text-white">{{ isNewSubscription ? '新增订阅' : '编辑订阅' }}</h3></template>
    <template #body>
      <div class="space-y-4">
        <div><label for="sub-edit-name" class="block text-sm font-medium text-gray-700 dark:text-gray-300">订阅名称</label><input type="text" id="sub-edit-name" v-model="editingSubscription.name" placeholder="（可选）不填将自动获取" class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white"></div>
        <div>
          <label for="sub-edit-url" class="block text-sm font-medium text-gray-700 dark:text-gray-300">订阅链接</label>
          <input type="text" id="sub-edit-url" v-model="editingSubscription.url" @input="handleSubUrlInput" placeholder="https://..." class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm font-mono dark:text-white" :class="subFormError ? 'border-red-500 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'">
        </div>
        <p v-if="subFormError" class="text-sm text-red-500">{{ subFormError }}</p>
        <div>
          <label for="sub-edit-exclude" class="block text-sm font-medium text-gray-700 dark:text-gray-300">包含/排除节点</label>
          <textarea 
            id="sub-edit-exclude" 
            v-model="editingSubscription.exclude"
            placeholder="[排除模式 (默认)]&#10;proto:vless,trojan&#10;(过期|官网)&#10;---&#10;[包含模式 (只保留匹配项)]&#10;keep:(香港|HK)&#10;keep:proto:ss"
            rows="5" 
            class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm font-mono dark:text-white">
          </textarea>
          <p class="text-xs text-gray-400 mt-1">每行一条规则。使用 `keep:` 切换为白名单模式。</p>
        </div>
      </div>
    </template>
  </Modal>
  
  <SettingsModal 
    v-model:show="uiStore.isSettingsModalVisible" 
    :export-backup="exportBackup"
    :import-backup="importBackup"
  />
  <SubscriptionImportModal :show="showSubscriptionImportModal" @update:show="showSubscriptionImportModal = $event" :add-nodes-from-bulk="addNodesFromBulk" />
  <UnifiedSortModal :show="showUnifiedSortModal" @update:show="showUnifiedSortModal = $event" :items="(() => {
      // 初始順序：若存在統一順序(後端保存的 combinedMisubs.id 順序)則按其順序；
      // 否則按全局設置 manualNodesPosition 組合
      const mapAll = new Map([
        ...subscriptions.map(s => [s.id, { id: s.id, name: s.name, type: 'sub' }]),
        ...manualNodes.map(n => [n.id, { id: n.id, name: n.name, type: 'node' }])
      ]);
      const items = [];
      if (unifiedOrderIds && unifiedOrderIds.length) {
        unifiedOrderIds.forEach(id => { if (mapAll.has(id)) items.push(mapAll.get(id)); });
        // append missing
        mapAll.forEach((v, id) => { if (!unifiedOrderIds.includes(id)) items.push(v); });
        return items;
      }
      const subItems = subscriptions.map(s => ({ id: s.id, name: s.name, type: 'sub' }));
      const nodeItems = manualNodes.map(n => ({ id: n.id, name: n.name, type: 'node' }));
      return (config.manualNodesPosition === 'after') ? [...subItems, ...nodeItems] : [...nodeItems, ...subItems];
    })()" :default-items="(() => {
      const subItems = subscriptions.map(s => ({ id: s.id, name: s.name, type: 'sub' }));
      const nodeItems = manualNodes.map(n => ({ id: n.id, name: n.name, type: 'node' }));
      return [...nodeItems, ...subItems];
    })()" @confirm="(orderedIds) => {
      const subMap = new Map(subscriptions.map(s => [s.id, s]));
      const nodeMap = new Map(manualNodes.map(n => [n.id, n]));
      const newSubs = []; const newNodes = [];
      for (const id of orderedIds) {
        if (subMap.has(id)) newSubs.push(subMap.get(id));
        else if (nodeMap.has(id)) newNodes.push(nodeMap.get(id));
      }
      for (const s of subscriptions) if (!newSubs.includes(s)) newSubs.push(s);
      for (const n of manualNodes) if (!newNodes.includes(n)) newNodes.push(n);
      subscriptions.splice(0, subscriptions.length, ...newSubs);
      manualNodes.splice(0, manualNodes.length, ...newNodes);
      unifiedOrderIds = orderedIds;
      markDirty();
    }" />
</template>

<style scoped>
.slide-fade-enter-active, .slide-fade-leave-active { transition: all 0.3s ease-out; }
.slide-fade-enter-from,
.slide-fade-leave-to {
  transform: translateY(-20px);
  opacity: 0;
}
.cursor-move {
  cursor: move;
}

.slide-fade-sm-enter-active,
.slide-fade-sm-leave-active {
  transition: all 0.2s ease-out;
}
.slide-fade-sm-enter-from,
.slide-fade-sm-leave-to {
  transform: translateY(-10px);
  opacity: 0;
}
</style>
