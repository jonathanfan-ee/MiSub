<script setup>
import { ref, watch, computed } from 'vue';
import Modal from './Modal.vue';
import { fetchSettings, saveSettings, migrateToD1 } from '../lib/api.js';
import { useToastStore } from '../stores/toast.js';
import { useSessionStore } from '../stores/session.js';

const props = defineProps({
  show: Boolean,
  exportBackup: Function,
  importBackup: Function,
});

const emit = defineEmits(['update:show']);

const { showToast } = useToastStore();
const sessionStore = useSessionStore();
const isLoading = ref(false);
const isSaving = ref(false);
const isMigrating = ref(false);
const settings = ref({});
const formError = ref('');
const migrationResult = ref(null);
const showMigrateConfirm = ref(false);

const hasWhitespace = computed(() => {
  const fieldsToCkeck = [
    'FileName',
    'mytoken',
    'profileToken',
    'subConverter',
    'subConfig',
    'BotToken',
    'ChatID',
    // 注意：clashMetaTemplateUrl 不检查，因为 URL 可能包含空格（虽然不推荐）
  ];

  for (const key of fieldsToCkeck) {
    const value = settings.value[key];
    if (value && /\s/.test(value)) {
      return true;
    }
  }
  return false;
});

// 验证存储类型设置
const isStorageTypeValid = computed(() => {
  const validTypes = ['kv', 'd1'];
  return validTypes.includes(settings.value.storageType);
});

const loadSettings = async () => {
  isLoading.value = true;
  try {
    settings.value = await fetchSettings();
  } catch (error) {
    showToast('加载设置失败', 'error');
  } finally {
    isLoading.value = false;
  }
};

const handleSave = async () => {
  formError.value = '';
  if (hasWhitespace.value) {
    formError.value = '输入项中不能包含空格，请检查后再试。';
    return;
  }

  if (!isStorageTypeValid.value) {
    formError.value = '存储类型设置无效，请选择有效的存储类型。';
    return;
  }

  isSaving.value = true;
  try {
    // 确保存储类型有默认值
    if (!settings.value.storageType) {
      settings.value.storageType = 'kv';
    }

    const result = await saveSettings(settings.value);
    if (result.success) {
      showToast(result.message || '设置已保存', 'success');
      // 之前这里是 window.location.reload()：整页刷新会触发 beforeunload
      // 的「有未保存更改」原生弹窗，还会丢掉仪表盘上尚未保存的改动。
      // 改为只重新拉取一次数据，让 config（token/文件名等）跟着更新。
      await sessionStore.refreshData();
      emit('update:show', false);
    } else {
      throw new Error(result.message || '保存失败');
    }
  } catch (error) {
    formError.value = error.message || '保存失败';
    showToast(error.message || '保存失败', 'error');
  } finally {
    isSaving.value = false;
  }
};

// 数据迁移处理函数（确认改用本站弹窗，不再用原生 confirm）
const handleMigrateToD1 = async () => {
  showMigrateConfirm.value = false;
  isMigrating.value = true;
  migrationResult.value = null;
  try {
    const result = await migrateToD1();
    if (result.success) {
      // 结果常驻显示在弹窗内，不只靠一条 3 秒就消失的 toast
      migrationResult.value = { ok: true, detail: result.details || null };
      showToast('数据迁移成功，已切换到 D1 数据库', 'success');
      settings.value.storageType = 'd1';
      // 后端 DataMigrator 已把 storageType 写进 D1，这里同步保存一次让两边一致
      await saveSettings(settings.value);
      await sessionStore.refreshData();
    } else {
      throw new Error(result.message || '迁移失败');
    }
  } catch (error) {
    migrationResult.value = { ok: false, detail: error.message };
    showToast(`迁移失败: ${error.message}`, 'error');
  } finally {
    isMigrating.value = false;
  }
};

// 监听 show 属性，当模态框从隐藏变为显示时，加载设置
watch(() => props.show, (newValue) => {
  if (newValue) {
    formError.value = '';
    migrationResult.value = null;
    loadSettings();
  }
});
</script>

<template>
  <Modal
    :show="show"
    @update:show="emit('update:show', $event)"
    @confirm="handleSave"
    :is-saving="isSaving"
    :close-on-confirm="false"
    size="2xl"
    confirm-text="保存设置"
    :confirm-disabled="hasWhitespace || !isStorageTypeValid"
    :confirm-button-title="hasWhitespace ? '输入内容包含空格，无法保存' : (!isStorageTypeValid ? '存储类型设置无效' : '')"
  >
    <template #title><h3 class="text-lg font-bold text-gray-800 dark:text-white">设置</h3></template>
    <template #body>
      <div v-if="isLoading" class="text-center p-8">
        <p class="text-gray-500">正在加载设置...</p>
      </div>
      <div v-else class="space-y-4">
        <p v-if="formError" class="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">{{ formError }}</p>
        <h4 class="text-md font-semibold text-gray-800 dark:text-white border-b border-gray-200 dark:border-gray-700 pb-2">基础</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label for="fileName" class="block text-sm font-medium text-gray-700 dark:text-gray-300">自定义订阅文件名</label>
          <input 
            type="text" id="fileName" v-model="settings.FileName" 
            class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white"
          >
        </div>
        <div>
          <label for="myToken" class="block text-sm font-medium text-gray-700 dark:text-gray-300">自定义订阅Token</label>
          <input 
            type="text" id="myToken" v-model="settings.mytoken"
            class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white"
          >
        </div>
        <div>
          <label for="profileToken" class="block text-sm font-medium text-gray-700 dark:text-gray-300">订阅组分享Token</label>
          <input 
            type="text" id="profileToken" v-model="settings.profileToken"
            class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white"
            placeholder="用于生成订阅组链接专用Token"
          >
          <p class="text-xs text-gray-400 mt-1">此Token专门用于生成订阅组链接，增强安全性。</p>
        </div>
        </div>

        <h4 class="text-md font-semibold text-gray-800 dark:text-white border-b border-gray-200 dark:border-gray-700 pb-2 pt-2">订阅转换</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label for="subConverter" class="block text-sm font-medium text-gray-700 dark:text-gray-300">SubConverter后端地址</label>
          <input
            type="text" id="subConverter" v-model="settings.subConverter"
            class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white"
          >
          <p class="text-xs text-gray-400 mt-1">第三方转换服务，会收到你的节点列表。可自建后替换。</p>
        </div>
        <div>
          <label for="subConfig" class="block text-sm font-medium text-gray-700 dark:text-gray-300">SubConverter配置文件</label>
          <input
            type="text" id="subConfig" v-model="settings.subConfig"
            class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white"
          >
        </div>
        </div>

        <!-- Clash Meta 直接生成模式 -->
        <div class="border-t border-gray-200 dark:border-gray-700 pt-4">
          <h4 class="text-md font-semibold text-gray-800 dark:text-white mb-3">🚀 Clash Meta 直接生成模式</h4>
          <div class="space-y-4">
            <!-- 启用直接生成模式 -->
            <div class="flex items-center justify-between p-3 bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-900/20 dark:to-blue-900/20 rounded-lg">
              <div>
                <p class="text-sm font-medium text-gray-700 dark:text-gray-200">启用直接生成 Clash Meta YAML</p>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">跳过 subconverter，直接生成适配 Clash Meta 的配置</p>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="settings.useDirectClashMeta" class="sr-only peer">
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-hidden rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-purple-600"></div>
              </label>
            </div>
            
            <!-- 模板 URL -->
            <div>
              <label for="clashMetaTemplateUrl" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Clash Meta 模板 URL
                <span class="text-xs text-gray-500 ml-1">(可选)</span>
              </label>
              <input 
                type="text" 
                id="clashMetaTemplateUrl" 
                v-model="settings.clashMetaTemplateUrl"
                placeholder="https://gist.githubusercontent.com/.../clash-meta-template.yaml"
                class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-purple-500 focus:border-purple-500 sm:text-sm dark:text-white"
              >
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                留空使用内置默认模板。推荐将模板上传到 GitHub Gist 并填入 Raw URL。
              </p>
            </div>
            
            <!-- 自动插入节点 -->
            <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
              <div>
                <p class="text-sm text-gray-700 dark:text-gray-200">自动插入节点到选择组</p>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">自动将节点插入到 select 类型的代理组中</p>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="settings.autoInsertToSelect" class="sr-only peer">
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-hidden rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-purple-600"></div>
              </label>
            </div>
            
            <!-- 提示信息 -->
            <div v-if="settings.useDirectClashMeta" class="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
              <p class="text-xs text-green-700 dark:text-green-300">
                ✅ 已启用直接生成模式！Clash Meta 用户将获得：<br>
                • 更快的响应速度（跳过第三方服务）<br>
                • 更好的兼容性（完整支持 Meta 新特性）<br>
                • 完全自定义（使用你自己的配置模板）<br>
                • 查看完整文档：<code class="text-xs bg-green-100 dark:bg-green-900 px-1 rounded">CLASH_META_DIRECT_MODE.md</code>
              </p>
            </div>
          </div>
        </div>

        <h4 class="text-md font-semibold text-gray-800 dark:text-white border-b border-gray-200 dark:border-gray-700 pb-2 pt-2">Telegram 通知</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
         <div>
          <label for="tgBotToken" class="block text-sm font-medium text-gray-700 dark:text-gray-300">Telegram Bot Token</label>
          <input
            type="text" id="tgBotToken" v-model="settings.BotToken"
            class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white"
          >
        </div>
        <div>
          <label for="tgChatID" class="block text-sm font-medium text-gray-700 dark:text-gray-300">Telegram Chat ID</label>
          <input
            type="text" id="tgChatID" v-model="settings.ChatID"
            class="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white"
          >
        </div>
        </div>
        <div class="space-y-2">
          <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
            <div>
              <p class="text-sm text-gray-700 dark:text-gray-200">订阅被访问时通知</p>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">客户端会定期自动更新订阅，开启后消息会很多。建议只在排查问题时打开。</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer shrink-0 ml-3">
              <input type="checkbox" v-model="settings.notifyOnSubAccess" class="sr-only peer">
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-hidden rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
            </label>
          </div>
          <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
            <p class="text-sm text-gray-700 dark:text-gray-200">保存设置时通知</p>
            <label class="relative inline-flex items-center cursor-pointer shrink-0 ml-3">
              <input type="checkbox" v-model="settings.notifyOnSettingsChange" class="sr-only peer">
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-hidden rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
            </label>
          </div>
        </div>
        <h4 class="text-md font-semibold text-gray-800 dark:text-white border-b border-gray-200 dark:border-gray-700 pb-2 pt-2">节点与输出</h4>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">节点名前缀</label>
          <div class="mt-2 space-y-2">
            <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
              <p class="text-sm text-gray-600 dark:text-gray-300">为机场订阅的节点添加订阅名前缀</p>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="settings.prependSubNameSubs" class="sr-only peer">
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-hidden rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
              </label>
            </div>
            <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
              <p class="text-sm text-gray-600 dark:text-gray-300">为手动节点添加“手动节点 - ”前缀</p>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="settings.prependSubNameManual" class="sr-only peer">
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-hidden rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
              </label>
            </div>
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">显示“流量剩余”虚拟节点</label>
          <div class="mt-2 flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
            <p class="text-sm text-gray-600 dark:text-gray-300">关闭后将不再在顶部插入“流量剩余”节点</p>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="settings.showTrafficRemainingNode" class="sr-only peer">
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-hidden rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
            </label>
          </div>
        </div>
        <!-- 移除“手动节点位置”设置，统一通过“统一排序”控制顺序，默认重置为“手动在前，订阅在后”。 -->
        <h4 class="text-md font-semibold text-gray-800 dark:text-white border-b border-gray-200 dark:border-gray-700 pb-2 pt-2">存储与备份</h4>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">数据存储类型</label>
          <div class="space-y-3">
            <div class="flex items-center">
              <input
                id="storage-kv"
                type="radio"
                value="kv"
                v-model="settings.storageType"
                class="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 dark:bg-gray-800"
              >
              <label for="storage-kv" class="ml-3 block text-sm text-gray-700 dark:text-gray-300">
                KV 存储（默认）
              </label>
            </div>
            <div class="flex items-center">
              <input
                id="storage-d1"
                type="radio"
                value="d1"
                v-model="settings.storageType"
                class="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 dark:bg-gray-800"
              >
              <label for="storage-d1" class="ml-3 block text-sm text-gray-700 dark:text-gray-300">
                D1 数据库（推荐，无写入限制）
              </label>
            </div>
            <div class="mt-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <p class="text-xs text-blue-600 dark:text-blue-400">
                💡 提示：D1 数据库没有 KV 的写入频率限制，适合频繁更新的场景。切换存储类型时系统会自动把现有数据同步到目标存储。
              </p>
            </div>
            <!-- 数据迁移按钮 -->
            <div v-if="settings.storageType === 'kv'" class="mt-3">
              <button
                @click="showMigrateConfirm = true"
                :disabled="isMigrating"
                class="w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-md transition-colors duration-200"
              >
                <span v-if="isMigrating">正在迁移数据...</span>
                <span v-else>🚀 迁移数据到 D1 数据库</span>
              </button>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                将现有 KV 数据迁移到 D1 数据库，解决写入限制问题
              </p>
            </div>
            <!-- 迁移结果常驻显示 -->
            <div v-if="migrationResult" class="mt-3 p-3 rounded-lg text-xs"
                 :class="migrationResult.ok ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'">
              <p v-if="migrationResult.ok">✅ 迁移完成，存储类型已切换为 D1 数据库。</p>
              <p v-else>❌ 迁移失败：{{ migrationResult.detail }}</p>
            </div>
          </div>
        </div>
        <!-- 数据管理 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">数据管理</label>
          <div class="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg space-y-3">
            <p class="text-xs text-gray-500 dark:text-gray-400">
              将会话数据（订阅、节点、订阅组）导出为 JSON 文件进行备份，或从备份文件中恢复。
            </p>
            <div class="flex flex-col sm:flex-row gap-3">
              <button
                @click="props.exportBackup"
                class="w-full px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-md transition-colors duration-200"
              >
                导出备份
              </button>
              <button
                @click="props.importBackup"
                class="w-full px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-md transition-colors duration-200"
              >
                导入备份
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </Modal>

  <!-- KV → D1 迁移确认（原来用的是原生 window.confirm） -->
  <Modal v-model:show="showMigrateConfirm" @confirm="handleMigrateToD1" danger confirm-text="开始迁移" confirm-keyword="MIGRATE">
    <template #title><h3 class="text-lg font-bold text-red-500">确认迁移到 D1 数据库</h3></template>
    <template #body>
      <p class="text-sm text-gray-600 dark:text-gray-300">
        这会把 KV 中的订阅、订阅组和设置复制到 D1 数据库，并把存储类型切换为 D1。
      </p>
      <ul class="text-xs text-gray-500 dark:text-gray-400 mt-2 space-y-1 list-disc list-inside">
        <li>KV 中的原数据不会被删除，可作为备份保留</li>
        <li>迁移前建议先「导出备份」</li>
        <li>需要已在 Cloudflare 项目中绑定 D1 数据库（MISUB_DB）</li>
      </ul>
      <div class="mt-4">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">请输入 <code class="px-1 bg-gray-100 dark:bg-gray-700 rounded">MIGRATE</code> 以确认</label>
        <p class="text-xs text-gray-400 mt-1">在下方确认框中输入后「开始迁移」按钮才可点击。</p>
      </div>
    </template>
  </Modal>
</template>
