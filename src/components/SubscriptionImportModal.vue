<script setup>
import { ref, watch } from 'vue';
import { useToastStore } from '../stores/toast.js';
import Modal from './Modal.vue';
import yaml from 'js-yaml'; // js-yaml is already in package.json
import { extractNodeName } from '../lib/utils.js';

const props = defineProps({
  show: Boolean,
  addNodesFromBulk: Function, // New prop
});

const emit = defineEmits(['update:show']);

const subscriptionUrl = ref('');
const isLoading = ref(false);
const errorMessage = ref('');

const toastStore = useToastStore();

watch(() => props.show, (newVal) => {
  if (!newVal) { // If modal is being hidden
    subscriptionUrl.value = '';
    errorMessage.value = '';
    isLoading.value = false;
  }
});

const isValidUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const parseNodes = (content) => {
  const nodes = [];
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');

  // Try Base64 decode first
  try {
    const decodedContent = atob(content);
    const decodedLines = decodedContent.split(/\r?\n/).filter(line => line.trim() !== '');
    if (decodedLines.some(line => line.includes('://'))) { // Heuristic: if decoded content looks like URLs
      for (const line of decodedLines) {
        if (line.includes('://')) {
          nodes.push({ id: crypto.randomUUID(), name: extractNodeName(line) || `Imported Node ${nodes.length + 1}`, url: line, enabled: true });
        }
      }
      if (nodes.length > 0) return nodes;
    }
  } catch (e) {
    // Not base64 or not a list of URLs after base64 decode
  }

  // Try YAML parsing (e.g., Clash config)
  try {
    const parsedYaml = yaml.load(content);
    if (parsedYaml && typeof parsedYaml === 'object' && Array.isArray(parsedYaml.proxies)) {
      // Clash 的 proxies 是结构化对象，没有等价的分享链接可以无损还原。
      // 这里只支持两种能真正还原的情况：
      //   1) 条目本身就是分享链接字符串
      //   2) 对象里带了原始链接字段（部分工具会保留 raw / link / url）
      // 之前的实现会拼出 `vmess://server:port` 这种假链接：它能通过前端校验被存下来，
      // 但既没有 uuid 也没有加密方式，聚合时会被后端静默丢掉，
      // 用户只会看到「导入了 N 个节点却一个都用不了」。
      for (const proxy of parsedYaml.proxies) {
        if (typeof proxy === 'string' && proxy.includes('://')) {
          nodes.push({ id: crypto.randomUUID(), name: extractNodeName(proxy) || `Imported Node ${nodes.length + 1}`, url: proxy, enabled: true });
          continue;
        }
        if (proxy && typeof proxy === 'object') {
          const raw = [proxy.raw, proxy.link, proxy.url, proxy.share].find(v => typeof v === 'string' && v.includes('://'));
          if (raw) {
            nodes.push({ id: crypto.randomUUID(), name: proxy.name || extractNodeName(raw) || `Imported Node ${nodes.length + 1}`, url: raw, enabled: true });
          }
        }
      }
      if (nodes.length > 0) return nodes;
      if (parsedYaml.proxies.length > 0) {
        throw new Error(`这是一份 Clash 配置（含 ${parsedYaml.proxies.length} 个代理），无法还原成节点分享链接。请把该链接作为「机场订阅」添加，或改用返回 Base64/节点列表的订阅地址。`);
      }
    }
  } catch (e) {
    // Clash 配置这种「识别出来但无法转换」的情况要明确告知用户
    if (e instanceof Error && e.message.startsWith('这是一份 Clash 配置')) throw e;
    // 其余情况：不是合法 YAML，继续走纯文本兜底
  }

  // Fallback to plain text (one URL per line)
  for (const line of lines) {
    if (line.includes('://')) { // Basic check for protocol
      nodes.push({ id: crypto.randomUUID(), name: extractNodeName(line) || `Imported Node ${nodes.length + 1}`, url: line, enabled: true });
    }
  }

  return nodes;
};

const importSubscription = async () => {
  errorMessage.value = '';
  if (!isValidUrl(subscriptionUrl.value)) {
    errorMessage.value = '请输入有效的 HTTP 或 HTTPS 订阅链接。';
    return;
  }

  isLoading.value = true;
  try {
    const response = await fetch('/api/fetch_external_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: subscriptionUrl.value })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }
    const content = await response.text();
    if (!content || !content.trim()) {
      errorMessage.value = '订阅链接返回了空内容，请检查链接是否有效。';
      return;
    }
    const newNodes = parseNodes(content);

    if (newNodes.length > 0) {
      props.addNodesFromBulk(newNodes);
      toastStore.showToast(`成功添加了 ${newNodes.length} 个节点，请记得保存。`, 'success');
      // 之前这里 emit('close')，而 close 既没在 defineEmits 里声明也没人监听，
      // 弹窗靠 Modal 的「确认即关闭」才碰巧关掉了；现在改为受控关闭。
      emit('update:show', false);
    } else {
      errorMessage.value = '未能从订阅链接中解析出任何节点。请确认链接返回的是 Base64/纯文本节点列表或 Clash 配置。';
    }
  } catch (error) {
    console.error('导入订阅失败:', error);
    errorMessage.value = `导入失败: ${error.message}`;
    toastStore.showToast(`导入失败: ${error.message}`, 'error');
  } finally {
    isLoading.value = false;
  }
};


</script>

<template>
  <Modal
    :show="show"
    @update:show="emit('update:show', $event)"
    @confirm="importSubscription"
    confirm-text="导入"
    :close-on-confirm="false"
    :is-saving="isLoading"
    :confirm-disabled="isLoading"
    size="lg"
  >
    <template #title><h3 class="text-lg font-bold text-gray-800 dark:text-white">导入订阅为手动节点</h3></template>
    <template #body>
      <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">
        输入订阅链接，系统会拉取并把里面的节点逐个添加为「手动节点」。支持 Base64、纯文本节点列表和 Clash YAML。
      </p>
      <input
        type="text"
        v-model="subscriptionUrl"
        placeholder="https://example.com/your-subscription-link"
        class="w-full p-2 border rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
        :class="errorMessage ? 'border-red-500' : 'border-gray-300 dark:border-gray-700'"
      />
      <p v-if="errorMessage" class="text-red-500 text-sm mt-2">{{ errorMessage }}</p>
      <p v-else class="text-xs text-gray-400 mt-2">如果只是想让这条订阅持续自动更新，请改用「机场订阅 → 新增」。</p>
    </template>
  </Modal>
</template>
