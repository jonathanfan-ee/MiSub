# User Configuration-Based Node Exclusion Implementation in MiSub

## Overview

MiSub implements a flexible and powerful user-configurable node filtering system that allows users to precisely control which nodes are included in the final subscription output through configuration rules. The system supports two modes: blacklist mode (exclude matches) and whitelist mode (include only matches).

## Implementation Architecture

### 1. Frontend User Interface (src/components/Dashboard.vue)

Users configure exclusion rules through a textarea in the subscription edit modal:

```vue
<textarea 
  id="sub-edit-exclude" 
  v-model="editingSubscription.exclude"
  placeholder="[Exclusion Mode (Default)]&#10;proto:vless,trojan&#10;(expired|official)&#10;---&#10;[Inclusion Mode (Keep only matches)]&#10;keep:(Hong Kong|HK)&#10;keep:proto:ss"
  rows="5"
>
</textarea>
```

### 2. Data Storage (src/composables/useSubscriptions.js)

Each subscription object includes an `exclude` property:

```javascript
function initializeSubscriptions(subsData) {
  subscriptions.value = (subsData || []).map(sub => ({
    ...sub,
    exclude: sub.exclude || '', // Stores user filtering rules
  }));
}
```

### 3. Backend Processing (functions/[[path]].js)

The core filtering logic is implemented in the `generateCombinedNodeList` function (lines 897-980):

```javascript
if (sub.exclude && sub.exclude.trim() !== '') {
    const rules = sub.exclude.trim().split('\n').map(r => r.trim()).filter(Boolean);
    const keepRules = rules.filter(r => r.toLowerCase().startsWith('keep:'));
    
    if (keepRules.length > 0) {
        // Whitelist mode processing
    } else {
        // Blacklist mode processing
    }
}
```

## Two Operating Modes

### 1. Blacklist Mode (Exclusion Mode) - Default

**Principle**: Nodes matching the rules are excluded, others are retained.

**Rule Types**:
- **Protocol filtering**: `proto:vless,trojan,ss`
- **Name filtering**: Regular expression patterns like `(expired|test)`

### 2. Whitelist Mode (Inclusion Mode) - `keep:` prefix

**Principle**: Only nodes matching the rules are retained, all others are excluded.

**Rule Format**:
```
keep:(Hong Kong|HK)
keep:proto:ss,vmess
```

## Technical Implementation Details

### Node Name Extraction
```javascript
const hashIndex = nodeLink.lastIndexOf('#');
if (hashIndex !== -1) {
    const nodeName = decodeURIComponent(nodeLink.substring(hashIndex + 1));
    // Use decoded node name for matching
}
```

### Protocol Extraction
```javascript
const protocolMatch = nodeLink.match(/^(.*?):\/\//);
const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : '';
```

### Regular Expression Construction
```javascript
// Combine multiple rules into one regex with OR logic
const nameRegex = new RegExp(nameRegexParts.join('|'), 'i');
```

## Usage Examples

### Example 1: Exclude specific protocols and keywords
```
proto:vless,trojan
(expired|test|official)
```

### Example 2: Keep only Hong Kong SS nodes
```
keep:(Hong Kong|HK)
keep:proto:ss
```

## Key Features

1. **Dual mode support**: Blacklist and whitelist modes
2. **Multi-type filtering**: Protocol and name-based filtering
3. **Regular expression support**: Complex pattern matching
4. **Error tolerance**: URL decode errors don't affect processing
5. **Case insensitive**: Better user experience
6. **Multi-rule combination**: Support for multiple filtering rules
7. **Real-time effect**: Rules take effect immediately in subscription generation

This implementation provides users with great flexibility to precisely control subscription output content, meeting various complex usage scenarios.