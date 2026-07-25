import { ref } from 'vue';
import { useToastStore } from '../stores/toast.js';
import { copyText } from '../lib/utils.js';

export function useProfiles(initialProfiles, markDirty, config) {
  const { showToast } = useToastStore();
  const profiles = ref([]);
  const isNewProfile = ref(false);
  const editingProfile = ref(null);
  const showProfileModal = ref(false);
  const showDeleteProfilesModal = ref(false);

  const initializeProfiles = () => {
    profiles.value = (initialProfiles.value || []).map(p => ({
      ...p,
      id: p.id || crypto.randomUUID(),
      enabled: p.enabled ?? true,
      subscriptions: p.subscriptions || [],
      manualNodes: p.manualNodes || [],
      customId: p.customId || ''
    }));
  };

  const handleProfileToggle = (updatedProfile) => {
    const index = profiles.value.findIndex(p => p.id === updatedProfile.id);
    if (index !== -1) {
      profiles.value[index].enabled = updatedProfile.enabled;
      markDirty();
    }
  };

  const handleAddProfile = () => {
    isNewProfile.value = true;
    editingProfile.value = { name: '', enabled: true, subscriptions: [], manualNodes: [], customId: '', subConverter: '', subConfig: '', expiresAt: '' };
    showProfileModal.value = true;
  };

  const handleEditProfile = (profileId) => {
    const profile = profiles.value.find(p => p.id === profileId);
    if (profile) {
      isNewProfile.value = false;
      editingProfile.value = JSON.parse(JSON.stringify(profile));
      editingProfile.value.expiresAt = profile.expiresAt || '';
      showProfileModal.value = true;
    }
  };

  const handleSaveProfile = (profileData) => {
    if (!profileData || !profileData.name) {
      showToast('订阅组名称不能为空', 'error');
      return;
    }
    if (profileData.customId) {
      profileData.customId = profileData.customId.replace(/[^a-zA-Z0-9-_]/g, '');
      if (profileData.customId && profiles.value.some(p => p.id !== profileData.id && p.customId === profileData.customId)) {
        showToast(`自定义 ID "${profileData.customId}" 已存在`, 'error');
        return;
      }
    }
    if (isNewProfile.value) {
      profiles.value.unshift({ ...profileData, id: crypto.randomUUID() });
    } else {
      const index = profiles.value.findIndex(p => p.id === profileData.id);
      if (index !== -1) profiles.value[index] = profileData;
    }
    markDirty();
    showProfileModal.value = false;
  };

  const handleDeleteProfile = (profileId) => {
    profiles.value = profiles.value.filter(p => p.id !== profileId);
    markDirty();
  };

  const handleDeleteAllProfiles = () => {
    profiles.value = [];
    markDirty();
    showDeleteProfilesModal.value = false;
  };

  /** 构造订阅组的分享链接，配置不全时返回 null。 */
  const getProfileLink = (profileId) => {
    const token = config.value?.profileToken;
    if (!token || token === 'auto' || !token.trim()) return null;
    const profile = profiles.value.find(p => p.id === profileId);
    if (!profile) return null;
    return `${window.location.origin}/${token}/${profile.customId || profile.id}`;
  };

  const copyProfileLink = async (profileId) => {
    const token = config.value?.profileToken;
    if (!token || token === 'auto' || !token.trim()) {
      showToast('请在设置中配置一个固定的“订阅组分享Token”', 'error');
      return;
    }
    const link = getProfileLink(profileId);
    if (!link) return;
    // 必须 await 并判断结果：http/IP 访问时 navigator.clipboard 不存在，
    // 之前会直接抛异常但仍然提示「已复制」。
    if (await copyText(link)) {
      showToast('订阅组分享链接已复制！', 'success');
    } else {
      showToast('自动复制失败，请手动复制链接', 'error');
    }
  };

  const cleanupSubscriptions = (subId) => {
    profiles.value.forEach(p => {
      p.subscriptions = p.subscriptions.filter(id => id !== subId);
    });
  };

  const cleanupNodes = (nodeId) => {
    profiles.value.forEach(p => {
      p.manualNodes = p.manualNodes.filter(id => id !== nodeId);
    });
  };
  
  const cleanupAllSubscriptions = () => {
    profiles.value.forEach(p => {
      p.subscriptions = [];
    });
  };

  const cleanupAllNodes = () => {
     profiles.value.forEach(p => {
      p.manualNodes = [];
    });
  };

  return {
    profiles,
    editingProfile,
    isNewProfile,
    showProfileModal,
    showDeleteProfilesModal,
    initializeProfiles,
    handleProfileToggle,
    handleAddProfile,
    handleEditProfile,
    handleSaveProfile,
    handleDeleteProfile,
    handleDeleteAllProfiles,
    copyProfileLink,
    getProfileLink,
    cleanupSubscriptions,
    cleanupNodes,
    cleanupAllSubscriptions,
    cleanupAllNodes,
  };
}
