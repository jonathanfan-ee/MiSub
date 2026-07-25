<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { useToastStore } from '../stores/toast.js';
import { useUIStore } from '../stores/ui.js';
import { copyText } from '../lib/utils.js';

const props = defineProps({
  config: Object,
  profiles: Array,
});

const { showToast } = useToastStore();
const uiStore = useUIStore();

const copied = ref(false);
let copyTimeout = null;

const formats = ['通用格式', 'Base64', 'Clash', 'Sing-Box', 'Surge', 'Loon'];
const selectedFormat = ref('通用格式');
const selectedId = ref('default');

// 每种格式给一句话导入提示，方便直接转述给客户
const formatHints = {
  '通用格式': '自动识别客户端类型下发对应配置，推荐直接把这条链接给客户。',
  'Base64': '适用于 v2rayN / v2rayNG / Shadowrocket 等。',
  'Clash': '适用于 Clash Verge / Mihomo / FlyClash / Stash。',
  'Sing-Box': '适用于 sing-box 内核客户端（SFI / SFA / SFM）。',
  'Surge': '适用于 Surge（iOS / macOS）。',
  'Loon': '适用于 Loon（iOS）。',
};

const requiredToken = computed(() => {
  return selectedId.value === 'default'
    ? { type: 'mytoken', value: props.config?.mytoken, name: '主 Token' }
    : { type: 'profileToken', value: props.config?.profileToken, name: '分享 Token' };
});

const isLinkValid = computed(() => {
  return requiredToken.value.value && requiredToken.value.value !== 'auto';
});

// 选中的订阅组是否已被停用 —— 停用组的链接会返回 404，交付前应该提醒
const selectedProfile = computed(() =>
  selectedId.value === 'default'
    ? null
    : (props.profiles || []).find(p => (p.customId || p.id) === selectedId.value)
);
const isSelectedDisabled = computed(() => !!selectedProfile.value && selectedProfile.value.enabled === false);

const subLink = computed(() => {
  if (!isLinkValid.value) {
    return `请先在“设置”中配置固定的 ${requiredToken.value.name}`;
  }

  const origin = window.location.origin;
  const token = requiredToken.value.value;
  let baseUrl = selectedId.value === 'default'
    ? `${origin}/${token}`
    : `${origin}/${token}/${selectedId.value}`;

  if (selectedFormat.value === '通用格式') {
    return baseUrl;
  }

  const targetMapping = { 'Sing-Box': 'singbox', 'QuanX': 'quanx' };
  const formatKey = (targetMapping[selectedFormat.value] || selectedFormat.value.toLowerCase());
  return `${baseUrl}?${formatKey}`;
});

const copyToClipboard = async () => {
    if (!isLinkValid.value) {
        showToast('链接无效，请先完成配置', 'error');
        return;
    }
    // 必须 await 并根据结果提示：http/IP 访问时 navigator.clipboard 不可用，
    // 之前会直接抛异常但仍然提示「已复制」。
    if (await copyText(subLink.value)) {
        showToast('已复制到剪贴板', 'success');
        copied.value = true;
        clearTimeout(copyTimeout);
        copyTimeout = setTimeout(() => { copied.value = false; }, 2000);
    } else {
        showToast('自动复制失败，请手动选中链接复制', 'error');
    }
};

// --- 二维码：方便客户用手机客户端直接扫码导入 ---
const showQr = ref(false);
const qrDataUrl = ref('');
const qrError = ref('');

const renderQr = async () => {
  qrError.value = '';
  qrDataUrl.value = '';
  if (!isLinkValid.value) return;
  try {
    // 按需加载，避免把 qrcode 打进首屏包
    const QRCode = (await import('qrcode')).default;
    qrDataUrl.value = await QRCode.toDataURL(subLink.value, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
  } catch (e) {
    console.error('QR generation failed:', e);
    qrError.value = '二维码生成失败';
  }
};

watch([showQr, subLink], ([visible]) => { if (visible) renderQr(); });

const selectAll = (event) => event.target.select();

onUnmounted(() => {
  clearTimeout(copyTimeout);
});
</script>

<template>
  <div class="sticky top-24">
    <div class="bg-white/50 dark:bg-gray-900/60 backdrop-blur-xs p-5 rounded-2xl shadow-lg dark:shadow-2xl ring-1 ring-black/5">
      <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-4">生成订阅链接</h3>

      <div class="mb-4">
        <label for="sub-content-select" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">1. 选择订阅内容</label>
        <select id="sub-content-select" v-model="selectedId" class="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm dark:text-white">
            <option value="default">默认订阅 (全部启用节点)</option>
            <option v-for="profile in profiles" :key="profile.id" :value="profile.customId || profile.id">
                {{ profile.name }}{{ profile.enabled === false ? '（已禁用）' : '' }}
            </option>
        </select>
        <p v-if="isSelectedDisabled" class="text-xs text-yellow-600 dark:text-yellow-500 mt-1">
          该订阅组当前已禁用，客户访问这条链接会收到「订阅组不存在或已停用」。启用后即可正常使用。
        </p>
      </div>

      <div class="mb-5">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">2. 选择格式</label>
        <div class="grid grid-cols-3 gap-2">
            <button
              v-for="format in formats"
              :key="format"
              @click="selectedFormat = format"
              class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex justify-center items-center"
              :class="[
                selectedFormat === format
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-gray-200/80 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300 hover:bg-gray-300/80 dark:hover:bg-gray-600/50'
              ]"
            >
              {{ format }}
            </button>
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-2">{{ formatHints[selectedFormat] }}</p>
      </div>

      <div class="relative">
        <input
          type="text"
          :value="subLink"
          readonly
          @focus="selectAll"
          @click="selectAll"
          :disabled="!isLinkValid"
          class="w-full text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800/50 rounded-lg pl-3 pr-10 py-2.5 focus:outline-hidden focus:ring-2 font-mono"
          :class="{
            'focus:ring-indigo-500': isLinkValid,
            'focus:ring-red-500 cursor-not-allowed': !isLinkValid,
            'text-red-500 dark:text-red-500': !isLinkValid
          }"
        />
        <button @click="copyToClipboard" :disabled="!isLinkValid" aria-label="复制订阅链接" title="复制订阅链接" class="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 transition-colors duration-200" :class="isLinkValid ? 'hover:text-indigo-500' : 'cursor-not-allowed'">
            <Transition name="fade" mode="out-in">
                <svg v-if="copied" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
            </Transition>
        </button>
      </div>

      <!-- 二维码：客户用手机客户端直接扫码导入，不必复制粘贴长链接 -->
      <div class="mt-3">
        <button
          @click="showQr = !showQr"
          :disabled="!isLinkValid"
          class="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed"
          :aria-expanded="showQr"
        >
          {{ showQr ? '隐藏二维码' : '显示二维码（手机扫码导入）' }}
        </button>
        <Transition name="fade">
          <div v-if="showQr && isLinkValid" class="mt-3 flex flex-col items-center gap-2 p-3 bg-white rounded-xl">
            <img v-if="qrDataUrl" :src="qrDataUrl" alt="订阅链接二维码" class="w-40 h-40" />
            <p v-else-if="qrError" class="text-xs text-red-500 py-8">{{ qrError }}</p>
            <p v-else class="text-xs text-gray-400 py-8">正在生成...</p>
            <p v-if="qrDataUrl" class="text-[11px] text-gray-500 text-center">
              用客户端的「扫码导入」功能扫描即可添加订阅
            </p>
          </div>
        </Transition>
      </div>

       <!-- isLinkValid 已经把 token 为空和 token === 'auto' 两种情况都排除了，
            所以这里只需要一条提示（原来还有一个 v-else-if 分支永远不会命中）。 -->
       <p v-if="!isLinkValid" class="text-xs text-yellow-600 dark:text-yellow-500 mt-2">
           提示：请在
           <button @click="uiStore.isSettingsModalVisible = true" class="font-bold underline hover:text-yellow-400">设置</button>
           中配置一个固定的 {{ requiredToken.name }}。默认值 <code>auto</code> 不能用于对外分享。
       </p>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
