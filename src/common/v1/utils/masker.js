// src/common/v1/utils/masker.js
// ============================================================
// Sensitive Data Masking
// ============================================================
// HOW IT WORKS:
//   1. Each entity can have a masking.config.json in its schemas/ folder
//   2. The config ONLY lists fields that need masking
//   3. Any field NOT in the config passes through UNTOUCHED
//   4. Field names are matched at ANY nesting depth in the payload
//      e.g. rule for "password" will mask:
//        payload.password
//        payload.user.password
//        payload.nested.deep.password
//        payload.items[0].password
//   5. If no entity config exists, a global fallback catches
//      common sensitive field names (password, credit card, etc.)
//
// MASKING IS SYNCHRONOUS — it runs during log entry construction
// before the entry is pushed to the async Kafka buffer. This is fast
// (just string manipulation) and does not block the API response.
//
// STRATEGIES:
//   full    — ****REDACTED****
//   lastN   — show last N chars: '4521123456784521' => '************4521'
//   firstN  — show first N chars: 'sk-abc123' => 'sk-a****'
//   email   — mask local part: 'john@gmail.com' => 'j****@gmail.com'
//   middle  — mask middle: 'Sarah' => 'Sa**h'
//   pattern — custom regex
//   none    — explicitly whitelisted (won't hit global fallback)
// ============================================================

const fs = require('fs');
const path = require('path');

const MASK_FULL = '****REDACTED****';

// ============================================================
// Config cache — loaded once per entity, then cached forever
// ============================================================
const configCache = new Map();

/**
 * Load masking rules for an entity.
 * Returns a Map<fieldName (lowercase) -> rule>
 */
function getEntityRules(entityName, version) {
  if (!entityName) return null;
  const key = `${entityName}/${version || 'v1'}`;
  if (configCache.has(key)) return configCache.get(key);

  const configPath = path.join(
    __dirname, '..', '..', '..', 'entities',
    entityName, version || 'v1', 'schemas', 'masking.config.json'
  );

  let ruleMap = null;
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const rules = raw.rules || [];
      if (rules.length > 0) {
        ruleMap = new Map();
        for (const rule of rules) {
          ruleMap.set(rule.field.toLowerCase(), rule);
        }
      }
    }
  } catch {
    // Invalid file — treat as no config
  }

  configCache.set(key, ruleMap);
  return ruleMap;
}

function clearCache() {
  configCache.clear();
}

// ============================================================
// Strategy implementations
// ============================================================
function applyStrategy(value, rule) {
  if (value === null || value === undefined) return value;
  const str = String(value);
  const mc = rule.maskChar || '*';
  const sc = rule.showChars || 4;

  switch (rule.strategy) {
    case 'none': return value;
    case 'full': return MASK_FULL;

    case 'lastN':
      if (str.length <= sc) return MASK_FULL;
      return mc.repeat(str.length - sc) + str.slice(-sc);

    case 'firstN':
      if (str.length <= sc) return MASK_FULL;
      return str.substring(0, sc) + mc.repeat(Math.min(str.length - sc, 12));

    case 'email': {
      const at = str.indexOf('@');
      if (at <= 0) return MASK_FULL;
      return str[0] + mc.repeat(4) + str.substring(at);
    }

    case 'middle': {
      if (str.length <= 2) return str;
      // Handle multi-word: "Sarah Johnson" => "Sa**h Jo***on"
      const words = str.split(/\s+/);
      if (words.length > 1) {
        return words.map(w => {
          if (w.length <= 2) return w;
          const keep = Math.min(2, Math.floor(w.length / 3));
          return w.substring(0, keep) + mc.repeat(w.length - keep * 2) + w.substring(w.length - keep);
        }).join(' ');
      }
      const keep = Math.min(2, Math.floor(str.length / 3));
      return str.substring(0, keep) + mc.repeat(str.length - keep * 2) + str.substring(str.length - keep);
    }

    case 'pattern':
      if (rule.pattern && rule.replacement !== undefined) {
        return str.replace(new RegExp(rule.pattern, 'g'), rule.replacement);
      }
      return MASK_FULL;

    default: return MASK_FULL;
  }
}

// ============================================================
// Global fallback rules — catches common sensitive field names
// when no entity-specific config exists
// ============================================================
const GLOBAL_RULES = new Map([
  // Full redaction
  ['password', { strategy: 'full' }],
  ['passwordhash', { strategy: 'full' }],
  ['secret', { strategy: 'full' }],
  ['secretanswer', { strategy: 'full' }],
  ['cvv', { strategy: 'full' }],
  ['ssn', { strategy: 'full' }],
  // Partial
  ['creditcardnumber', { strategy: 'lastN', showChars: 4 }],
  ['cardnumber', { strategy: 'lastN', showChars: 4 }],
  ['authorization', { strategy: 'firstN', showChars: 4 }],
  ['apikey', { strategy: 'firstN', showChars: 4 }],
  ['api_key', { strategy: 'firstN', showChars: 4 }],
  ['token', { strategy: 'firstN', showChars: 4 }],
  ['apitoken', { strategy: 'firstN', showChars: 4 }],
]);

// Partial match patterns for global fallback (field name CONTAINS these)
const GLOBAL_PARTIAL = [
  { pattern: 'creditcard', rule: { strategy: 'lastN', showChars: 4 } },
  { pattern: 'carddetail', rule: { strategy: 'full' } },
];

function globalMask(fieldName, value) {
  const lower = fieldName.toLowerCase();
  // Exact match
  const exact = GLOBAL_RULES.get(lower);
  if (exact) return applyStrategy(value, exact);
  // Partial match
  for (const { pattern, rule } of GLOBAL_PARTIAL) {
    if (lower.includes(pattern)) return applyStrategy(value, rule);
  }
  return value; // No match — pass through untouched
}

// ============================================================
// Main: deep-mask an object
// Walks every key at every depth. If the key matches a rule
// (entity-specific or global), the value is masked.
// Fields NOT in any rule are left completely untouched.
// ============================================================
function maskObject(obj, entityName, version, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 15 || obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  const entityRules = getEntityRules(entityName, version);

  if (Array.isArray(obj)) {
    return obj.map(function(item) { return maskObject(item, entityName, version, depth + 1); });
  }

  var masked = {};
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = obj[key];

    if (value !== null && value !== undefined && typeof value === 'object') {
      // Recurse into nested objects and arrays
      masked[key] = maskObject(value, entityName, version, depth + 1);
    } else if (typeof value === 'string' || typeof value === 'number') {
      var lower = key.toLowerCase();

      // 1. Check entity-specific rules first
      if (entityRules) {
        var entityRule = entityRules.get(lower);
        if (entityRule) {
          masked[key] = applyStrategy(String(value), entityRule);
          continue;
        }
      }

      // 2. Global fallback
      masked[key] = globalMask(key, String(value));
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

/**
 * Mask HTTP headers (always uses global rules).
 */
function maskHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  var masked = {};
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'cookie') {
      masked[key] = applyStrategy(String(headers[key]), { strategy: 'firstN', showChars: 4 });
    } else {
      masked[key] = headers[key];
    }
  }
  return masked;
}

module.exports = {
  maskObject,
  maskHeaders,
  applyStrategy,
  getEntityRules,
  clearCache,
  MASK_FULL,
};
